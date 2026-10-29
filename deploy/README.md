# Run injoy on a host, not on your desk

The tunnel in `publish\` publishes the copy running on **this** machine: switch
the PC off and the URL dies with it. This folder is the other half — the same
app provisioned onto a machine that stays up, so the site keeps answering with
nothing of yours switched on.

The app has no npm dependencies, so a 1 GB VM is enough for the catalog, and a
2 GB one is enough with Chrome (the resolver). Downloads live on that host's
disk, not yours.

---

## The free-forever host

**Oracle Cloud Always Free** is the only free tier that gives you a real,
always-on machine with the disk and the egress this app needs:

| | Always Free allowance |
| --- | --- |
| Compute | Ampere A1: **4 OCPU / 24 GB RAM** (or 2 × AMD micro) |
| Disk | **200 GB** block storage total |
| Egress | **10 TB / month** outbound |
| Lifetime | No expiry — it is a permanent free tier, not a trial |
| Card | Required for identity verification, never charged on Always Free |

10 TB a month is roughly 30,000 hours of 720p — you will not reach it.

### 1. Create the instance

1. Sign up at <https://www.oracle.com/cloud/free/> and pick a home region close
   to you. Ampere capacity is not available in every region; if the shape is
   greyed out, try another region or retry later.
2. **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04**
   - Shape: **Ampere → VM.Standard.A1.Flex**, 4 OCPU / 24 GB
   - Boot volume: raise it to **100 GB** (still inside the free 200 GB)
   - Under *Add SSH keys*: **Save private key** and **Save public key** — keep
     the private key, that is how you get in.
3. **Networking → VCN → Security lists → Default Security List** → add an
   ingress rule: source `0.0.0.0/0`, protocol `TCP`, destination port `80`.
4. Copy the instance's **public IP**.

### 2. Push the app

From this repo, on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\push.ps1 `
  -Server <public-ip> `
  -Key "$HOME\Downloads\ssh-key-2026-10-29.key"
```

That packs `server/`, `public/` and `deploy/`, copies them over SSH, and runs
`deploy/bootstrap.sh` as root. It installs Node 22 and headless Chrome, creates
an `injoy` service user, puts the app in `/opt/injoy`, its data in
`/var/lib/injoy`, and starts `injoy.service` on port 80 with
`Restart=always`. It prints the URL when `/api/health` answers.

`-NoProvision` uploads without running anything, `-User root` is for hosts that
do not have an `ubuntu` account, `-Port` changes the SSH port.

### 3. It survives everything

```bash
systemctl status injoy      # running, enabled at boot
journalctl -u injoy -f      # live logs
sudo reboot                 # comes back on its own
```

Nothing on your PC is involved after step 2. Close the laptop.

---

## Updates

Re-run `deploy\push.ps1`. It replaces `server/` and `public/`, keeps
`/var/lib/injoy` untouched (watchlist, progress, downloads), and restarts the
service. Media you have already cached stays cached.

## A domain and TLS

Point an `A` record at the instance, then provision with the domain:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\push.ps1 -Server <ip> -Key <key>
ssh ubuntu@<ip> "sudo DOMAIN=injoy.example.com bash /tmp/injoy/deploy/bootstrap.sh /tmp/injoy"
```

`bootstrap.sh` installs Caddy, reverse-proxies to the app, and gets a free
Let's Encrypt certificate automatically. Open ports 80 and 443 in the security
list first.

## Without Oracle

The same `bootstrap.sh` runs on any Ubuntu 22.04/24.04 box — Hetzner, DigitalOcean,
a Raspberry Pi on your shelf, a spare laptop under the desk. `push.ps1` does not
care whose machine it is.

| Host | Free? | Always on? | Verdict |
| --- | --- | --- | --- |
| Oracle Always Free | yes, forever | yes | the one that fits |
| Google Cloud e2-micro | yes | yes | 1 GB RAM, 30 GB disk — catalog works, Chrome will thrash |
| Render / Koyeb free | yes | no | sleeps after idle, ephemeral disk, no Chrome |
| Fly.io | no | yes | free allowance ended |
| Cloudflare Workers | yes | yes | no filesystem and no browser, so no resolver and no downloads — embeds only |
| This PC + `publish\` | yes | no | perfect while the machine is on |

## Notes

- **Chrome is the resolver.** Without it `/api/play/:id` answers with an embed
  and background caching is skipped. `bootstrap.sh` installs it.
- **Disk is the cache.** `MEDIA_CACHE_GB` (default 40) caps downloaded media;
  set it in `/etc/systemd/system/injoy.service` and `systemctl daemon-reload`.
- **No auth layer.** The watchlist and progress endpoints are open. A public
  deployment is a public deployment.
- **Oracle idle reclaim.** Always Free instances that sit idle can be reclaimed
  after long inactivity; a site that serves traffic is not idle. Upgrading the
  account to pay-as-you-go removes the policy entirely and still bills nothing
  inside the free allowance.
