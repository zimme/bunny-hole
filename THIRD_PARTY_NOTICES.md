# Third-party notices

Bunny Hole embeds the following independently maintained executable in its host and
connector images and release archives:

- **frp 0.70.1**, copyright the frp authors, licensed under Apache-2.0. Source and
  license: <https://github.com/fatedier/frp/tree/v0.70.1>. The downloaded release
  archives are verified against checksums recorded in `third_party/frp.json`. A copy of
  the license is shipped in each runtime image and connector archive and is checked in
  at `third_party/frp.LICENSE`.

No source modifications are made to frp. Bunny Hole's control plane and authorization
plugin constrain how the embedded executable may register proxies.

- **Mozilla CA certificate bundle**, extracted and published by curl, licensed under
  MPL-2.0. Source: <https://curl.se/ca/cacert-2026-08-13.pem>. The pinned provenance,
  source date, and SHA-256 values are recorded in `third_party/ca-certificates.json`.
  The bundle and MPL-2.0 license text are checksum-verified before inclusion in the
  connector OCI image and every native connector archive.
