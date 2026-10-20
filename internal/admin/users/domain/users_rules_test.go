package domain

import "testing"

func TestWorkspaceName(t *testing.T) {
	if WorkspaceName(" Ada @x", "ada@pod.example") != "Ada 的工作空间" {
		t.Fatal(WorkspaceName(" Ada @x", "ada@pod.example"))
	}
	if WorkspaceName("", "ada@pod.example") != "ada 的工作空间" {
		t.Fatal("email label")
	}
	if WorkspaceName("", "@x") != "PodHub 的工作空间" {
		t.Fatal("fallback")
	}
}
