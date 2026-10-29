# M6a test font

`NotoSansKR-Regular-subset.otf` is a modified (subset) version of Noto Sans KR 2.004, used only
as a test fixture of the M6a text work (`docs/plans/mvp-m6a-text-model-contract.md`, M6a-Q13 and
the M6a-U5 notes in section 16). It is distributed under the SIL Open Font License 1.1, whose
text is in `OFL.txt` beside it. "Noto" is a trademark of Google; no trademark rights are granted.

Source: `Sans/SubsetOTF/KR/NotoSansKR-Regular.otf` of https://github.com/notofonts/noto-cjk at
tag `Sans2.004` (commit 523d033d6cb47f4a80c58a35753646f5c3608a78), SHA-256
`69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68`. Subset SHA-256
`3d21bfdb71ca17f2e83373faa52918e8942ec8d99185b2325d92963fc90c4324` (71,420 bytes).

Subset with fonttools 4.68.0:

```sh
pyftsubset NotoSansKR-Regular.otf \
  --unicodes="U+0020-007E,U+00A0,U+00AD,U+3000-303F,U+FF01-FF60,U+AC00,U+AC01,U+AD6D,U+AE00,U+AE30,U+B098,U+B155,U+B2C8,U+B2E4,U+B3D9,U+B77C,U+B9C8,U+BC14,U+BCA1,U+C0AC,U+C138,U+C2B5,U+C544,U+C548,U+C694,U+C790,U+C9D1,U+CC28,U+CC44,U+CC9C,U+CD94,U+CE74,U+D0C0,U+D0DD,U+D130,U+D30C,U+D3B8,U+D558,U+D55C,U+D588" \
  --layout-features='*' --name-IDs='*' --name-languages='*' \
  --output-file=NotoSansKR-Regular-subset.otf
```

The subsetter dropped the `GDEF` and `DSIG` tables.
