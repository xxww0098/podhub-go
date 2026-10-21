package domain

import "testing"

// FulfillerID is the plan 7.1 override: staff name the recipient when the
// source has none, or to correct the automatic choice. DecodeDispatch runs
// with DisallowUnknownFields, so before this field existed a request carrying
// fulfillerId was rejected outright as "请求格式无效". These vectors pin the
// three shapes that matter: absent (keep automatic), present (trim it), and
// explicitly empty (same as absent, never a zero uuid).
func TestDecodeDispatchFulfillerID(t *testing.T) {
	const ok = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{
			name: "absent keeps the automatic choice",
			body: `{"sourceId":" src_1 ","lineIds":["11111111-1111-1111-1111-111111111111"]}`,
			want: "",
		},
		{
			name: "present is trimmed",
			body: `{"sourceId":"src_1","lineIds":["11111111-1111-1111-1111-111111111111"],"fulfillerId":"  ` + ok + `  "}`,
			want: ok,
		},
		{
			name: "explicit empty stays empty",
			body: `{"sourceId":"src_1","lineIds":["11111111-1111-1111-1111-111111111111"],"fulfillerId":"   "}`,
			want: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, err := DecodeDispatch([]byte(tc.body))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if in.FulfillerID != tc.want {
				t.Fatalf("FulfillerID = %q, want %q", in.FulfillerID, tc.want)
			}
			if in.SourceID != "src_1" {
				t.Fatalf("SourceID = %q", in.SourceID)
			}
		})
	}
}

// Go matches JSON keys case-insensitively, so fulfillerID (and any other
// casing) is the same field, not an unknown one. That is harmless -- it
// cannot silently fall back to the automatic choice -- but pinning it here
// keeps a future switch to a case-sensitive decoder from being a surprise.
func TestDecodeDispatchFulfillerKeyIsCaseInsensitive(t *testing.T) {
	const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	in, err := DecodeDispatch([]byte(`{"sourceId":"src_1","lineIds":["11111111-1111-1111-1111-111111111111"],"fulfillerID":"` + id + `"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if in.FulfillerID != id {
		t.Fatalf("FulfillerID = %q, want %q", in.FulfillerID, id)
	}
}
