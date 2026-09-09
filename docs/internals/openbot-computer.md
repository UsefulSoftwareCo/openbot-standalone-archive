# OpenBot computer control

## Why the macOS helper is a bundle, launched through Launch Services

TCC records Screen Recording and Accessibility against a bundle identifier plus
a code signature, and it does not attribute a request to the process that made
it — it walks up to a _responsible_ process. Both facts constrain the design of
[`native/computer-helper`](../../native/computer-helper/README.md):

- A bare SwiftPM executable has no bundle identifier, so it can never hold
  either grant. The helper ships as `T3ComputerHelper.app` with bundle id
  `codes.t3.openbot.computer-helper`, and the server launches the executable
  inside that bundle.
- A helper spawned as an ordinary child of the server is attributed to whatever
  started the server — an SSH session, a terminal, `tailscaled`. Probed both
  ways on one machine, the same bundle reports `screenCapture: granted` as a
  terminal's child (inheriting the terminal's grant) and `denied` when launched
  with `open -n -a` into the login session. The second is the honest answer and
  the only one the user can act on in System Settings.

So `login-session` launch is the product path, not an optimisation:
`/usr/bin/open -n -a` plus a token-authenticated Unix socket (mode 0600) and a
ready file, because Launch Services leaves no pipe to read. `--stdio` remains a
diagnostic mode; `T3CODE_COMPUTER_HELPER_LAUNCH=child` selects it.

The consequence to know about: ad-hoc signing pins a grant to the code hash, so
every rebuild drops both grants. `scripts/make-signing-identity.sh` creates the
stable certificate that avoids it, and should be run before granting anything.

## Why launched windows are placed, not claimed

The reference client's `WindowAdopter` opens a 30 s window after launch and
adopts whatever new window appears in it, on the theory that a slow-to-map app
window still counts as "from this launch". That claim is global: any window
that happens to map in that window — a person's own app, a dialog from
something else entirely — gets moved onto the launcher's screen. This was not
ported. A chat's launch only ever places the window it itself opened.
