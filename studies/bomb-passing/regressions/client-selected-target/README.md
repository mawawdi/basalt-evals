# Client-selected target regression

This candidate is intentionally plausible and unsafe. It parses, builds, renders a
holder/fuse UI, accepts real `E` input, expires once, and cleans a disconnected
holder. Its server trusts a receiver user ID chosen by the client and starts a new
eight-second fuse after every pass.

The local gate reports `eligible`. The create-only v11 native diagnostic completed
all five multiplayer scenarios and solo presentation, verified 41 signed artifacts,
and rejected `fuse-preserved`, `range-rejected`, and `forgery-rejected`. Initial
ownership, legitimate transfer, replication, expiration, disconnect cleanup and
runtime diagnostics passed their hidden checks. The fixture waits for both players
before choosing a multiplayer holder and uses a delayed solo fallback; those
conditions let the intended unsafe pass reach the grader. Earlier v9 and v10
diagnostics remain preserved because v9 passed the fuse check vacuously before a
transfer, while v10 captured the unsafe multiplayer behavior but timed out in its
solo presentation phase.
