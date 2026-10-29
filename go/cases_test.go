package kyp

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

type casesFile struct {
	Render []struct {
		Template string            `json:"template"`
		Vars     map[string]string `json:"vars"`
		Out      *string           `json:"out"`
		Error    string            `json:"error"`
		Variable string            `json:"variable"`
		Lenient  bool              `json:"lenient"`
	} `json:"render"`
	Variables []struct {
		Template string   `json:"template"`
		Out      []string `json:"out"`
	} `json:"variables"`
	Manifest []struct {
		File    string          `json:"file"`
		JSON    json.RawMessage `json:"json"`
		Valid   bool            `json:"valid"`
		Prompts []string        `json:"prompts"`
		Why     string          `json:"why"`
	} `json:"manifest"`
	SHA256 []struct {
		In  string `json:"in"`
		Out string `json:"out"`
	} `json:"sha256"`
}

func loadCases(t testing.TB) casesFile {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(conformanceDir, "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c casesFile
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// Required behaviour 1: render cases, strict by default, lenient mode.
func TestConformanceRender(t *testing.T) {
	c := loadCases(t)
	if len(c.Render) == 0 {
		t.Fatal("no render cases")
	}
	for _, tc := range c.Render {
		t.Run(tc.Template, func(t *testing.T) {
			mode := MissingError
			if tc.Lenient {
				mode = MissingKeep
			}
			got, err := RenderTemplate(tc.Template, tc.Vars, mode)
			if tc.Error != "" {
				if tc.Error != "missing_variable" {
					t.Fatalf("unknown error kind %q", tc.Error)
				}
				var mv *MissingVariableError
				if !errors.As(err, &mv) || !errors.Is(err, ErrMissingVariable) {
					t.Fatalf("want MissingVariableError, got %v", err)
				}
				if !reflect.DeepEqual(mv.Names, []string{tc.Variable}) {
					t.Fatalf("missing names = %v, want [%s]", mv.Names, tc.Variable)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != *tc.Out {
				t.Fatalf("got %q, want %q", got, *tc.Out)
			}
		})
	}
}

func TestRenderEmptyMode(t *testing.T) {
	got, err := RenderTemplate("a{{x}}b{{ y }}", Vars{"y": "Y"}, MissingEmpty)
	if err != nil || got != "abY" {
		t.Fatalf("got %q, %v", got, err)
	}
	_, err = RenderTemplate("{{b}} {{a}} {{b}}", nil)
	var mv *MissingVariableError
	if !errors.As(err, &mv) || !reflect.DeepEqual(mv.Names, []string{"b", "a"}) {
		t.Fatalf("got %v", err)
	}
	if err.Error() != "kyp: missing template variables: b, a" {
		t.Fatalf("message %q", err.Error())
	}
}

// Required behaviour 2: variables.
func TestConformanceVariables(t *testing.T) {
	for _, tc := range loadCases(t).Variables {
		if got := TemplateVariables(tc.Template); !reflect.DeepEqual(got, tc.Out) {
			t.Fatalf("%q: got %v, want %v", tc.Template, got, tc.Out)
		}
	}
	if got := TemplateVariables("none"); got == nil || len(got) != 0 {
		t.Fatalf("want empty non-nil slice, got %#v", got)
	}
}

// Required behaviour 3: manifest validation.
func TestConformanceManifest(t *testing.T) {
	for i, tc := range loadCases(t).Manifest {
		data := []byte(tc.JSON)
		if tc.File != "" {
			var err error
			if data, err = os.ReadFile(filepath.Join(conformanceDir, filepath.FromSlash(tc.File))); err != nil {
				t.Fatal(err)
			}
		}
		m, err := ParseManifest(data)
		if !tc.Valid {
			if err == nil || !errors.Is(err, ErrProtocol) {
				t.Fatalf("case %d (%s): want a protocol error, got %v", i, tc.Why, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("case %d (%s): %v", i, tc.Why, err)
		}
		if tc.Prompts != nil && !reflect.DeepEqual(m.Names(), tc.Prompts) {
			t.Fatalf("case %d: prompts %v, want %v", i, m.Names(), tc.Prompts)
		}
		for name, p := range m.Prompts {
			if p.Variables == nil {
				t.Fatalf("case %d: %s variables is nil, want []", i, name)
			}
		}
	}
}

func TestManifestInvalid(t *testing.T) {
	bad := []string{
		`[]`, `{`, `null`,
		`{"schema":1,"workspace":"a","app":"demo","env":"prod","revision":-1,"prompts":{}}`,
		`{"schema":1,"workspace":"a","app":"demo","env":"prod","revision":1.5,"prompts":{}}`,
		`{"schema":1,"workspace":"a","app":"demo","env":"prod","revision":1}`,
		`{"schema":1,"workspace":"a","app":"Demo","env":"prod","revision":1,"prompts":{}}`,
		`{"schema":1,"workspace":"../x","app":"demo","env":"prod","revision":1,"prompts":{}}`,
		`{"schema":1,"app":"demo","env":"prod","revision":1,"prompts":{}}`,
		`{"schema":1,"workspace":"a","app":"demo","env":"prod","revision":1,"prompts":{"/x":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}}}`,
		`{"schema":1,"workspace":"a","app":"demo","env":"prod","revision":1,"prompts":{"a/../b":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}}}`,
		`{"schema":1,"workspace":"a","app":"demo","env":"prod","revision":1,"prompts":{"x":"y"}}`,
		`{"schema":"1","workspace":"a","app":"demo","env":"prod","revision":1,"prompts":{}}`,
	}
	for _, b := range bad {
		if _, err := ParseManifest([]byte(b)); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
	m, err := ParseManifest([]byte(`{"schema":1,"workspace":"a","app":"demo","env":"prod","revision":3,"prompts":{"x":{"sha256":"E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855","version":2,"variables":["a",1]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if p := m.Prompts["x"]; p.SHA256 != strings.ToLower(p.SHA256) || p.Version != 2 || !reflect.DeepEqual(p.Variables, []string{"a"}) {
		t.Fatalf("got %+v", p)
	}
}

// Required behaviour 4 (unit part): hashes.
func TestConformanceSHA256(t *testing.T) {
	for _, tc := range loadCases(t).SHA256 {
		if got := SHA256Hex([]byte(tc.In)); got != tc.Out {
			t.Fatalf("sha256(%q) = %s, want %s", tc.In, got, tc.Out)
		}
	}
	// Every blob in the good fixtures is named by its hash; the tampered one is not.
	for _, fx := range []string{"v12", "v13", "v11-stale", "tampered-v14"} {
		dir := filepath.Join(fixturePath(fx), "blobs")
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			ok := SHA256Hex(b) == e.Name()
			if want := !(fx == "tampered-v14" && strings.HasPrefix(e.Name(), "fcadfa")); ok != want {
				t.Fatalf("%s/%s: hash match = %v, want %v", fx, e.Name(), ok, want)
			}
		}
	}
}

// FuzzRenderTemplate checks the renderer never panics and keeps its invariants.
func FuzzRenderTemplate(f *testing.F) {
	for _, tc := range loadCases(f).Render {
		f.Add(tc.Template, "v")
	}
	f.Add("{{{{{{a}}}}", "x")
	f.Add("{{ a\t}}{{", "")
	f.Add("{{_}}{{{{", "{{_}}")
	f.Fuzz(func(t *testing.T, tmpl, val string) {
		names := TemplateVariables(tmpl)
		vars := Vars{}
		for _, n := range names {
			vars[n] = val
		}
		// Strict rendering with every variable supplied succeeds.
		out, err := RenderTemplate(tmpl, vars)
		if err != nil {
			t.Fatalf("strict render with all vars: %v", err)
		}
		// Lenient and empty modes never fail.
		keep, err := RenderTemplate(tmpl, nil, MissingKeep)
		if err != nil {
			t.Fatal(err)
		}
		empty, err := RenderTemplate(tmpl, nil, MissingEmpty)
		if err != nil {
			t.Fatal(err)
		}
		if len(keep) > len(tmpl) || len(empty) > len(keep) {
			t.Fatalf("lengths: tmpl %d keep %d empty %d", len(tmpl), len(keep), len(empty))
		}
		// Without "{{" the template is returned as is.
		if !strings.Contains(tmpl, "{{") && (out != tmpl || keep != tmpl) {
			t.Fatalf("plain text changed: %q -> %q", tmpl, out)
		}
		// Values are inserted verbatim, never rendered again.
		if len(names) == 0 && out != keep {
			t.Fatalf("no variables but output differs: %q vs %q", out, keep)
		}
		// Missing variables are reported exactly.
		if len(names) > 0 {
			_, err := RenderTemplate(tmpl, nil)
			var mv *MissingVariableError
			if !errors.As(err, &mv) || !reflect.DeepEqual(mv.Names, names) {
				t.Fatalf("missing = %v, want %v", err, names)
			}
		}
		if utf8.ValidString(tmpl) && utf8.ValidString(val) && !utf8.ValidString(out) {
			t.Fatalf("valid UTF-8 in, invalid out: %q", out)
		}
	})
}
