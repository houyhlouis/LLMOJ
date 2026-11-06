# Statement Downloads

[简体中文](Statement-Downloads.zh-CN.md) | English

## A problem's statement as Markdown

**Download statement (.md)** on a problem page (in the right-hand menu) saves the statement as one Markdown file,
named after the problem (`A+B Problem.md`). It holds:

- the title, time and memory limits (the smallest and largest of the test cases, as the page shows them), and the input and output (standard, file names, interactive, function interface or answer submission);
- every statement section the page shows, its text exactly as written: formulas (`$…$`, `$$…$$`), images, tables and HTML stay as they are;
- each sample's input and output as code blocks, before its explanation;
- the source, and the names of the problem's additional files when you may download them.

A contest problem page has the same button (**Download statement (Markdown)**): the title and the file names are
the contest's, and the labels are in the statement's language.

## A contest's problems as a ZIP

**Download problems (ZIP)** on a contest's overview (once its problems are open to you) saves:

```
Contest title.zip
├── statements.pdf
├── test/
│   ├── sample1.in
│   ├── sample1.ans
│   └── (the problem's attachments)
├── A+B Problem/
│   └── …
└── …
```

- **statements.pdf**: a first page with the contest's title, times (in your time zone), rules and a table of its problems with their limits and input/output, then every statement from a new page in contest order (A, B, …), with formulas, images and tables, samples named as in the folders, an outline entry per problem and page numbers. Chinese and English text are both set (Noto Sans, Noto Sans SC).
- **A folder per problem**, named exactly as the problem: only characters that can't be in a file name (`< > : " / \ | ? *`, control characters) become `_`, and reserved Windows names (`CON`, `NUL`, …) get a `_`. Two problems with the same name (also differing only in case) get `test` and `test (2)`.
- **Samples** in statement order, `sample1.in` / `sample1.ans`, byte for byte.
- **Attachments**: what the contest problem page lists (the contest's attachments, and a communication problem's public headers for participants), when you have the privilege to download attachments. An attachment named like a sample gets ` (2)`.

Nothing else goes in: no test data, checkers, interactors, graders or other judge-only files, and no
scoreboard, submissions or statistics. Before a contest starts, only its managers can download its problems.

### Images in the PDF

The server downloads statement images for the PDF: PNG and JPEG as they are, the first frame of a GIF, and SVG as
vectors. Only `http(s)` images on the public Internet and `data:` images are used; an image on a private network
or on the server itself, a WebP image, or one larger than 8 MiB is replaced by a note, and the page says which
images were left out. The images of one PDF are downloaded within 40 seconds.

### Load

The PDF is typeset in a worker thread, one at a time per backend process. Everyone who downloads the same contest
in the same language and time zone shares one PDF (kept 10 minutes), so the start of a contest makes it once. When
eight PDFs are already waiting, a download is refused as busy; one that takes over two minutes is stopped.
