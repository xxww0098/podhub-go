package fieldpack

import "testing"

func TestEncodeBodyMatchesSerdeOrder(t *testing.T) {
	raw, err := EncodeBody([]byte(`{"complex_values":[],"values":{"b":{"kind":"integer","value":2},"a":{"kind":"text","value":"x"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"values":{"a":{"kind":"text","value":"x"},"b":{"kind":"integer","value":2}},"complex_values":[]}`
	if string(raw) != want {
		t.Fatalf("%s", raw)
	}
	cleared, err := EncodeBody([]byte(`{"values":{},"complex_values":[],"cleared":["b","a"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(cleared) != `{"values":{},"complex_values":[],"cleared":["a","b"]}` {
		t.Fatalf("%s", cleared)
	}
	if _, err := EncodeBody([]byte(`{"values":{"a":{"kind":"decimal","value":1.5}},"complex_values":[]}`)); err == nil {
		t.Fatal("decimal must stay unported")
	}
}
