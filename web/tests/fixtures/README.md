# Browser test data

`mock-browser-forbidden-paths.json` owns hostile URL inputs shared by the
context network guard, isolated HTTP server tests, and the mock browser runner.
Every path is a **rejection probe**, never a runner output directory or a
resource to read. Keep their literal spelling, including encoded traversal:
normalizing these strings would remove the cases the guards need to reject.

The unit tests require blocked requests and zero downstream file lookup.
The browser runner uses the deliberately absent traversal target so even a
guard failure cannot expose an actual local secret. Its expected denial is
part of the negative-scenario verdict.

Listing-core browser snapshots and their native parity checks are described in
[listing-core](listing-core/README.md).
