# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**
(<https://github.com/yehsung/IAMCEO/security/advisories/new>).

Please do **not** open a public issue, pull request or discussion for a vulnerability. The IAMCEO server can run commands on the Mac it is installed on, so a public report puts every user at risk before a fix exists.

A useful report says:

- the version you tested (the app's version, or the commit if you built from source)
- what an attacker needs to start from (same tailnet, same Mac user, a link the user clicks, a file an agent reads, and so on)
- steps to reproduce, and what the attacker gains

Do not include real access codes, tokens or private keys in the report.

## Supported versions

Only the latest release gets security fixes. Fixes are not back-ported to older versions.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Anything older | No — update first |

## What counts

Read the trust model first: [docs/security.en.md](docs/security.en.md) ([한국어](docs/security.md)). It says what IAMCEO trusts, what it blocks and what it does not try to block.

In scope, for example:

- reaching the user API without the access code, or from an address the server should refuse
- an agent session reading or changing another project through IAMCEO's own tools
- a file or artifact shown in the app reaching the server API, the access code or the network
- the installer or the release accepting a changed download

Known limits that are documented there are not vulnerabilities by themselves — for example, an agent session runs as the same macOS user as the server and can read that user's files with its shell. A way to make such a limit worse than documented is still worth reporting.
