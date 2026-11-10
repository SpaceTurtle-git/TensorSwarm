# Security

## Trust model

TensorSwarm runs **arbitrary Python code** sent from the dashboard on every worker. It has no
user accounts: anyone who can reach the Master on port 8000 can run code on all workers and
read every dataset. It is meant for a **trusted group on a private Tailscale network** (a
class, a lab team).

- Network traffic is encrypted by Tailscale (WireGuard).
- `install.cmd` creates Windows Firewall rules that accept connections **only from Tailscale
  addresses** (`100.64.0.0/10`), so other people on the campus LAN can't reach the cluster.
- Code runs as the Windows user who started the worker, with that user's file access.

Hardening steps (Tailscale ACLs, worker isolation, resource limits) are in
[docs/SECURITY_GUIDE.md](docs/SECURITY_GUIDE.md).

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security tab → *Report a vulnerability*), with steps to reproduce.
