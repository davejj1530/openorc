# Security reporting

Report suspected vulnerabilities privately through GitHub private vulnerability reporting, not in public issues.

## Report a vulnerability privately

On the repository page, open the **Security and quality** tab and click **Report a vulnerability**. GitHub shares the report privately with the repository maintainers. See [GitHub's reporter instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

Do not post vulnerability details, credentials, private conversations, or application databases in an issue or pull request.

Include the affected OpenOrc version or commit, operating system, minimal reproduction with synthetic data, expected boundary, and observed impact. Relevant areas include provider permissions, local MCP tools, embedded content, credential storage, and file access. Share only the information needed to reproduce the problem; replace real credentials and private project data with placeholders.

## Supported versions and response

OpenOrc is in beta and has no stable releases yet. Reports should identify the tested version or commit; fixes target the current development branch. No support window or response-time commitment is offered. Maintainers coordinate investigation and disclosure through the private report.

For ordinary bugs, setup questions, and feature requests, use the routes in [SUPPORT.md](SUPPORT.md).
