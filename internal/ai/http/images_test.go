package aihttp

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

func TestImageNormalizationAndLimits(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 0})
	var src bytes.Buffer
	_ = png.Encode(&src, img)
	raw, err := jpegImage(src.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	r, g, b, _ := decoded.At(0, 0).RGBA()
	if r < 65000 || g < 65000 || b < 65000 {
		t.Fatalf("transparent pixel not white: %d %d %d", r, g, b)
	}
	for _, bad := range [][]byte{nil, []byte("not an image"), make([]byte, maxImageBytes+1)} {
		if _, err = jpegImage(bad); err == nil {
			t.Fatal("invalid image accepted")
		}
	}
}

type imageTestTransport func(*http.Request) (*http.Response, error)

func (f imageTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestImageProviderContractAndDownloadRefusals(t *testing.T) {
	var pixels bytes.Buffer
	_ = png.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	for _, scenario := range []string{"valid", "private-output", "redirect", "wrong-count", "wrong-model", "oversize"} {
		t.Run(scenario, func(t *testing.T) {
			calls := 0
			client := *ImageNetworkClient()
			client.Transport = imageTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				status, body := 200, []byte(nil)
				if calls == 1 {
					if r.Header.Get("Authorization") != "Bearer test-secret" {
						t.Fatal("provider authorization missing")
					}
					var request map[string]any
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request["n"] != float64(1) || request["model"] != imageModel {
						t.Fatalf("request contract %v %v", request, err)
					}
					outputURL := "https://image.oss-cn-beijing.aliyuncs.com/result.png"
					count, model := 1, imageModel
					if scenario == "private-output" {
						outputURL = "http://127.0.0.1/image"
					}
					if scenario == "wrong-count" {
						count = 2
					}
					if scenario == "wrong-model" {
						model = "unverified-model"
					}
					if scenario == "redirect" {
						return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://evil.example/"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
					}
					body, _ = json.Marshal(map[string]any{"model": model, "data": []map[string]string{{"url": outputURL}}, "usage": map[string]int{"image_count": count}})
				} else {
					if r.Header.Get("Authorization") != "" {
						t.Fatal("provider key leaked to image host")
					}
					body = pixels.Bytes()
					if scenario == "oversize" {
						body = make([]byte, maxImageBytes+1)
					}
				}
				return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
			})
			provider := bailianImages{endpoint: "https://test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/images/generations", model: imageModel, key: "test-secret", client: &client}
			got, err := provider.Generate(context.Background(), []byte("source"), "preserve product")
			if scenario == "valid" {
				if err != nil || !bytes.Equal(got, pixels.Bytes()) || calls != 2 {
					t.Fatalf("valid result %v calls %d", err, calls)
				}
			} else {
				if err == nil || calls > 2 {
					t.Fatalf("refusal %v calls %d", err, calls)
				}
				if scenario != "oversize" && calls != 1 {
					t.Fatal("refused response downloaded or retried")
				}
			}
		})
	}
}

func TestImagePreparationGateReleasesOnce(t *testing.T) {
	first, ok := takeImagePreparation()
	if !ok {
		t.Fatal("first gate")
	}
	second, ok := takeImagePreparation()
	if !ok {
		first()
		t.Fatal("second gate")
	}
	if extra, ok := takeImagePreparation(); ok {
		extra()
		t.Fatal("gate exceeded")
	}
	first()
	first()
	third, ok := takeImagePreparation()
	if !ok {
		t.Fatal("gate not released")
	}
	second()
	third()
}
func TestImageEgressBoundary(t *testing.T) {
	for _, raw := range []string{"http://x.cn-beijing.maas.aliyuncs.com/v1", "https://x.cn-beijing.maas.aliyuncs.com:444/v1", "https://user:secret@x.cn-beijing.maas.aliyuncs.com/v1", "https://x.cn-beijing.maas.aliyuncs.com/?x=1", "https://127.0.0.1/v1", "https://x.cn-beijing.maas.aliyuncs.com.evil.test/v1"} {
		if _, err := ImageEndpoint(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if got, err := ImageEndpoint("https://example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"); err != nil || got != "https://example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/images/generations" {
		t.Fatalf("%s %v", got, err)
	}
	for _, raw := range []string{"127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.1.1", "198.18.1.1", "192.0.2.1", "2001:db8::1", "224.0.0.1", "0.0.0.0"} {
		if imagePublicIP(netip.MustParseAddr(raw)) {
			t.Fatalf("accepted %s", raw)
		}
	}
	if !imagePublicIP(netip.MustParseAddr("8.8.8.8")) {
		t.Fatal("public address refused")
	}
}
