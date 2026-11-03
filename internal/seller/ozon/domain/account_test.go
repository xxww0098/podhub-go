package domain

import "testing"

func TestPhysicalAccountKeyFollowsClientIdentity(t *testing.T) {
	if PhysicalAccountKey("client-a") != PhysicalAccountKey(" client-a ") {
		t.Fatal("normalization changed physical identity")
	}
	if PhysicalAccountKey("client-a") == PhysicalAccountKey("client-b") {
		t.Fatal("different clients share an occupancy scope")
	}
	if PhysicalAccountKey("client-a") == "client-a" {
		t.Fatal("raw client id exposed")
	}
}
