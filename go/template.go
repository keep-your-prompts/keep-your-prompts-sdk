package kyp

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Vars holds template values: {{name}} is replaced by Vars["name"].
type Vars map[string]string

// OnMissing selects what Render does with a {{variable}} that has no value.
type OnMissing int

const (
	// MissingError returns a *MissingVariableError (the default).
	MissingError OnMissing = iota
	// MissingKeep leaves {{name}} in the output ("lenient" mode).
	MissingKeep
	// MissingEmpty replaces it with "".
	MissingEmpty
)

func identStart(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' }
func identChar(c byte) bool  { return identStart(c) || (c >= '0' && c <= '9') }
func isSpace(c byte) bool    { return c == ' ' || c == '\t' }

// parseVar parses "{{ name }}" at t[i:] (t[i:i+2] == "{{"). It returns the name
// and the index just after "}}", or ok=false if this is not a variable.
func parseVar(t string, i int) (name string, end int, ok bool) {
	j := i + 2
	for j < len(t) && isSpace(t[j]) {
		j++
	}
	if j >= len(t) || !identStart(t[j]) {
		return "", 0, false
	}
	start := j
	for j < len(t) && identChar(t[j]) {
		j++
	}
	name = t[start:j]
	for j < len(t) && isSpace(t[j]) {
		j++
	}
	if j+1 >= len(t) || t[j] != '}' || t[j+1] != '}' {
		return "", 0, false
	}
	return name, j + 2, true
}

// scan walks the template, calling lit for literal text and v for each
// variable (name and its raw source text), in order.
func scan(t string, lit func(string), v func(name, raw string)) {
	i, run := 0, 0
	for i < len(t) {
		k := strings.Index(t[i:], "{{")
		if k < 0 {
			break
		}
		open := i + k
		if strings.HasPrefix(t[open:], "{{{{") {
			lit(t[run:open])
			lit("{{")
			i, run = open+4, open+4
			continue
		}
		if name, end, ok := parseVar(t, open); ok {
			lit(t[run:open])
			v(name, t[open:end])
			i, run = end, end
		} else {
			i = open + 2 // not a variable: the braces stay as text
		}
	}
	lit(t[run:])
}

// RenderTemplate replaces every {{name}} in tmpl with vars[name]. Spaces inside
// the braces are allowed; names match [A-Za-z_][A-Za-z0-9_]*. "{{{{" renders a
// literal "{{". There is no logic, looping or escaping, and values are not
// rendered again.
//
// A variable without a value is an error (*MissingVariableError listing every
// missing name) unless onMissing is MissingKeep or MissingEmpty.
func RenderTemplate(tmpl string, vars Vars, onMissing ...OnMissing) (string, error) {
	mode := MissingError
	if len(onMissing) > 0 {
		mode = onMissing[0]
	}
	// Fast path: nothing to substitute.
	if !strings.Contains(tmpl, "{{") {
		return tmpl, nil
	}
	var b strings.Builder
	b.Grow(len(tmpl) + 64)
	var missing []string
	scan(tmpl, func(s string) { b.WriteString(s) }, func(name, raw string) {
		if val, ok := vars[name]; ok {
			b.WriteString(val)
			return
		}
		switch mode {
		case MissingKeep:
			b.WriteString(raw)
		case MissingEmpty:
		default:
			for _, m := range missing {
				if m == name {
					return
				}
			}
			missing = append(missing, name)
		}
	})
	if len(missing) > 0 {
		return "", &MissingVariableError{Names: missing}
	}
	return b.String(), nil
}

// TemplateVariables returns the distinct variable names in tmpl, in order of
// first appearance. It never returns nil.
func TemplateVariables(tmpl string) []string {
	names := []string{}
	scan(tmpl, func(string) {}, func(name, _ string) {
		for _, n := range names {
			if n == name {
				return
			}
		}
		names = append(names, name)
	})
	return names
}

// SHA256Hex returns the lowercase hex SHA-256 of data.
func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
