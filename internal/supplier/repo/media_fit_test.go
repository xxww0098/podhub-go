package supplierrepo

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

// fitImageOracle is the pre-pool scaler: image.At plus canvas.Set.
func fitImageOracle(body []byte, edge uint32, ext string) ([]byte, string) {
	img, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		return body, domain.ContentTypeForExt(ext)
	}
	b := img.Bounds()
	longest := b.Dx()
	if b.Dy() > longest {
		longest = b.Dy()
	}
	dst := img
	if longest > int(edge) && edge > 0 {
		scale := float64(edge) / float64(longest)
		w := int(float64(b.Dx()) * scale)
		h := int(float64(b.Dy()) * scale)
		if w < 1 {
			w = 1
		}
		if h < 1 {
			h = 1
		}
		canvas := image.NewRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				sx := b.Min.X + x*b.Dx()/w
				sy := b.Min.Y + y*b.Dy()/h
				canvas.Set(x, y, img.At(sx, sy))
			}
		}
		dst = canvas
	}
	white := image.NewRGBA(dst.Bounds())
	draw.Draw(white, white.Bounds(), image.White, image.Point{}, draw.Src)
	draw.Draw(white, white.Bounds(), dst, dst.Bounds().Min, draw.Over)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, white, &jpeg.Options{Quality: 75}); err != nil {
		return body, domain.ContentTypeForExt(ext)
	}
	if longest <= int(edge) && len(body) <= buf.Len() {
		return body, domain.ContentTypeForExt(ext)
	}
	return buf.Bytes(), "image/jpeg"
}

func TestFitImageMatchesAtSet(t *testing.T) {
	jpg := mustJPEG(t, 160, 90)
	pngBody := mustPNG(t)
	small := mustJPEG(t, 8, 6)
	cases := []struct {
		name string
		body []byte
		edge uint32
		ext  string
	}{
		{name: "jpg", body: jpg, edge: 40, ext: "jpg"},
		{name: "png-alpha", body: pngBody, edge: 12, ext: "png"},
		{name: "small", body: small, edge: 64, ext: "jpg"},
		{name: "garbage", body: []byte("not-an-image"), edge: 32, ext: "png"},
		{name: "webp-undecoded", body: []byte("RIFF"), edge: 32, ext: "webp"},
	}
	for _, cse := range cases {
		got, gotCT := fitImage(cse.body, cse.edge, cse.ext)
		want, wantCT := fitImageOracle(cse.body, cse.edge, cse.ext)
		if gotCT != wantCT || !bytes.Equal(got, want) {
			t.Fatalf("%s content-type %s want %s bytes %d want %d equal %v", cse.name, gotCT, wantCT, len(got), len(want), bytes.Equal(got, want))
		}
	}
	if _, ct := fitImage([]byte("RIFF"), 32, "webp"); ct != "image/webp" {
		t.Fatal(ct)
	}
	if _, ct := fitImage(small, 64, "jpg"); ct != domain.ContentTypeForExt("jpg") && ct != "image/jpeg" {
		t.Fatal(ct)
	}
}

func TestScaleNearestMatchesRGBASet(t *testing.T) {
	ycbcr := decodeJPEG(t, mustJPEG(t, 48, 30))
	rgba := image.NewRGBA(image.Rect(0, 0, 21, 13))
	nrgba := image.NewNRGBA(image.Rect(2, 3, 19, 17))
	for y := nrgba.Rect.Min.Y; y < nrgba.Rect.Max.Y; y++ {
		for x := nrgba.Rect.Min.X; x < nrgba.Rect.Max.X; x++ {
			nrgba.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 9), G: uint8(y * 5), B: 30, A: uint8((x*17 + y) % 256)})
		}
	}
	for y := 0; y < 13; y++ {
		for x := 0; x < 21; x++ {
			rgba.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y * 3), B: 9, A: 255})
		}
	}
	for _, src := range []image.Image{ycbcr, rgba, nrgba} {
		b := src.Bounds()
		w, h := 11, 7
		got := image.NewRGBA(image.Rect(0, 0, w, h))
		scaleNearest(got, src)
		want := image.NewRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				sx := b.Min.X + x*b.Dx()/w
				sy := b.Min.Y + y*b.Dy()/h
				want.Set(x, y, src.At(sx, sy))
			}
		}
		if !bytes.Equal(got.Pix, want.Pix) {
			t.Fatalf("%T pix mismatch", src)
		}
	}
}

func TestFetchLoopbackStopsWhenParentCancels(t *testing.T) {
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-started:
		default:
			close(started)
		}
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := fetchLoopback(ctx, loopbackAccount(srv.URL), "a.jpg", time.Minute, 20*time.Second)
		errc <- err
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("parent cancel left the fetch running to success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("parent cancel did not stop the fetch")
	}
}

func TestFetchLoopbackReturnsBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		w.Write([]byte("jpeg-bytes"))
	}))
	defer srv.Close()
	body, err := fetchLoopback(context.Background(), loopbackAccount(srv.URL), "a.jpg", 300*time.Second, 20*time.Second)
	if err != nil || string(body) != "jpeg-bytes" {
		t.Fatalf("%q %v", body, err)
	}
}

func loopbackAccount(endpoint string) sign.Account {
	return sign.Account{
		Provider:        sign.ProviderGeneric,
		Endpoint:        endpoint,
		Region:          "auto",
		Bucket:          "bucket",
		ForcePathStyle:  true,
		AccessKeyID:     "AKIATEST",
		SecretAccessKey: "secret",
	}
}

func mustJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 40, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func mustPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 30, 18))
	for y := 0; y < 18; y++ {
		for x := 0; x < 30; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: 220, G: uint8(x * 3), B: uint8(y * 5), A: uint8(30 + x*5)})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func decodeJPEG(t *testing.T, body []byte) image.Image {
	t.Helper()
	img, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := img.(*image.YCbCr); !ok {
		t.Fatalf("jpeg decoded as %T", img)
	}
	return img
}

var benchJPEG = func() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 320, 240))
	for y := 0; y < 240; y++ {
		for x := 0; x < 320; x++ {
			img.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 40, A: 255})
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90})
	return buf.Bytes()
}()

func BenchmarkFitImage(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		fitImage(benchJPEG, 128, "jpg")
	}
}

func BenchmarkFitImageOracle(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		fitImageOracle(benchJPEG, 128, "jpg")
	}
}

func BenchmarkFitImageConc8(b *testing.B) {
	b.ReportAllocs()
	total := b.N
	var n atomic.Int64
	var wg sync.WaitGroup
	wg.Add(8)
	b.ResetTimer()
	for g := 0; g < 8; g++ {
		go func() {
			defer wg.Done()
			for {
				i := n.Add(1)
				if i > int64(total) {
					return
				}
				fitImage(benchJPEG, 128, "jpg")
			}
		}()
	}
	wg.Wait()
}
