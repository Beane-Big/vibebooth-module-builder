package main

import "testing"

// Upload validation must preserve opt-in permissions without granting default roles.
func TestInspectSourceOptInPermission(t *testing.T) {
	for _, prefix := range []string{"", "vibebooth-module-demo-main/"} {
		t.Run(prefix, func(t *testing.T) {
			files := moduleFiles(prefix)
			files[0].body += "permissions:\n  - {id: video-export, name: 视频导出, default: [], opt_in: true}\n"
			source, err := inspectSource(writeZip(t, files...))
			if err != nil {
				t.Fatal(err)
			}
			permission := source.manifest.PermissionByID("video-export")
			if permission == nil || !permission.OptIn || len(permission.Default) != 0 {
				t.Fatalf("opt-in permission lost its default-deny behavior: %+v", permission)
			}
		})
	}
}
