package licenses

// listStamp is the SHA-256 of THIRD-PARTY-LICENSES.md.
// scripts/check-third-party-licenses.py --update rewrites this constant so
// the test binary changes with the list. go test otherwise caches a pass
// without noticing edits to files outside this package.
const listStamp = "d9a1b7374b1b40bb18a3f57d5f951ec2830b3fd7a143073e3e6434997b937c1c"
