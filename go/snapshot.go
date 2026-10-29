package kyp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Snapshot is a complete, verified copy of one app environment: the raw
// manifest and every blob it names.
type Snapshot struct {
	Manifest    *Manifest
	RawManifest []byte            // exactly as served
	Blobs       map[string][]byte // sha256 -> body
	Source      string            // mirror it came from
}

// Snapshot returns the state the client currently holds.
func (c *Client) Snapshot() (*Snapshot, error) {
	s := c.cur.Load()
	if s == nil {
		return nil, &unavailableError{msg: "nothing loaded for " + c.what()}
	}
	snap := &Snapshot{
		Manifest:    s.manifest,
		RawManifest: append([]byte(nil), s.raw...),
		Blobs:       make(map[string][]byte, len(s.bySHA)),
		Source:      c.Status().Source,
	}
	for sha, text := range s.bySHA {
		snap.Blobs[sha] = []byte(text)
	}
	return snap, nil
}

// WriteDir writes the protocol layout (envs/<app>/<env>.json, blobs/<sha256>)
// under dir. Files are written atomically; existing blobs are kept.
func (s *Snapshot) WriteDir(dir string) (blobsWritten int, err error) {
	if s == nil || s.Manifest == nil {
		return 0, errors.New("kyp: empty snapshot")
	}
	for sha, body := range s.Blobs {
		name := filepath.Join(dir, "blobs", sha)
		if existing, err := os.ReadFile(name); err == nil && SHA256Hex(existing) == sha {
			continue
		}
		if err := atomicWrite(name, body); err != nil {
			return blobsWritten, err
		}
		blobsWritten++
	}
	m := filepath.Join(dir, "envs", s.Manifest.App, s.Manifest.Env+".json")
	if err := atomicWrite(m, s.RawManifest); err != nil {
		return blobsWritten, err
	}
	return blobsWritten, nil
}

// PullSnapshot fetches the deployed state of opts.App/opts.Env from the
// network mirrors (CDN and origin with a delivery key, the git mirror, or
// opts.Mirrors). It ignores the embedded snapshot, snapshot folder and disk
// cache, so the result is what is deployed now.
func PullSnapshot(ctx context.Context, opts Options, extra ...Option) (*Snapshot, error) {
	for _, fn := range extra {
		fn(&opts)
	}
	opts.Embedded = nil
	opts.SnapshotDir = ""
	opts.CacheDir = ""
	opts.APIKey = ""
	opts.PollInterval = 24 * time.Hour
	if len(opts.Mirrors) == 0 && opts.DeliveryKey == "" && opts.GitMirror == "" && len(opts.ExtraMirrors) == 0 {
		return nil, errors.New("kyp: nothing to pull from: set KYP_DELIVERY_KEY (or a git mirror)")
	}
	c, err := New(ctx, opts)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	snap, err := c.Snapshot()
	if err != nil {
		return nil, fmt.Errorf("kyp: pull: %w", err)
	}
	return snap, nil
}
