package licenses

// listStamp is the SHA-256 of THIRD-PARTY-LICENSES.md.
// scripts/check-third-party-licenses.py --update rewrites this constant so
// the test binary changes with the list. go test otherwise caches a pass
// without noticing edits to files outside this package.
const listStamp = "b25ac4d3dd5b4493a3ffc7cceb77aab6dcf5fecae52652641d7102b37d957547"
