package kyp

import (
	"context"
	"testing"
)

func benchClient(b *testing.B) *Client {
	c, err := New(context.Background(), Options{App: "demo", SnapshotDir: fixturePath("v12"), Logger: quietLogger()})
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { c.Close() })
	return c
}

func BenchmarkGet(b *testing.B) {
	c := benchClient(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := c.Get("greeting"); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkGetParallel(b *testing.B) {
	c := benchClient(b)
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := c.Get("greeting"); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkRender(b *testing.B) {
	c := benchClient(b)
	vars := Vars{"name": "Ana", "company": "Acme"}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := c.Render("greeting", vars); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkRenderParallel(b *testing.B) {
	c := benchClient(b)
	vars := Vars{"name": "Ana", "company": "Acme"}
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := c.Render("greeting", vars); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkRenderTemplate4KB(b *testing.B) {
	tmpl := ""
	for len(tmpl) < 4096 {
		tmpl += "Some plain prompt text for {{company}} with {{ name }} inside. "
	}
	vars := Vars{"name": "Ana", "company": "Acme"}
	b.ReportAllocs()
	b.SetBytes(int64(len(tmpl)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := RenderTemplate(tmpl, vars); err != nil {
			b.Fatal(err)
		}
	}
}
