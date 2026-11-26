# Security policy

## Supported versions

Orbitrace has no released versions yet. Reports about the current code on `dev` and `main` are welcome.

## Reporting a vulnerability

Report vulnerabilities privately with GitHub's private vulnerability reporting for this repository:

1. Open <https://github.com/farisology/orbitrace>.
2. Open the **Security and quality** tab (called **Security** in older GitHub layouts). If you do not see it, open the **...** menu and choose it there.
3. Choose **Report a vulnerability**, fill in the form and submit it.

Do not open a public issue or a public pull request for a security problem. Do not include real session content in the report. Describe the problem with an invented example.

If **Report a vulnerability** is missing, private reporting is not enabled yet. Do not post the details publicly. Open a public issue that asks the owner for a private security contact, and leave out every detail of the problem.

A useful report says:

- what the problem is and which package it affects (`core`, `renderer`, `app`, `vscode` or `cli`);
- the commit you tested;
- the steps to reproduce, using invented data;
- what an attacker could read or change, and what it would take.

No response time is promised yet, because nothing is released.

## Areas of particular interest

These are design requirements. None of them is built yet.

- The planned browser view must listen on loopback only, on a random port, with a one-time token in the link, a Host header check and no cross-origin access. Without the token, any web page open in the same browser could read transcripts from localhost.
- A shared replay file must contain only the fields listed in [docs/privacy.md](docs/privacy.md). Any way to make a shared file carry transcript content is a security problem.
