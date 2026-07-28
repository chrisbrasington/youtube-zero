import asyncio
import shlex

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

app = FastAPI()


async def adb(*args: str, timeout: int = 15) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        "adb", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
            await proc.wait()
        except ProcessLookupError:
            pass
        return 124, "", "timeout"
    return proc.returncode, out.decode(errors="replace").strip(), err.decode(errors="replace").strip()


# The one failure that isn't a bug and isn't fixable from here: the TV has
# forgotten (or never accepted) this server's adb key. Only someone standing in
# front of the TV can clear it, so say so instead of dumping adb's stderr.
UNAUTHORIZED_HELP = (
    "TV hasn't authorized this server. Look at the TV for an "
    "\"Allow debugging?\" dialog and accept it (tick \"Always allow\"). "
    "No dialog? Settings → Developer options → Revoke debugging "
    "authorizations, then try again."
)


async def device_state(target: str) -> str:
    """One of adb's own words: device | unauthorized | offline | missing."""
    _, out, _ = await adb("devices", timeout=10)
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[0] == target:
            return parts[1]
    return "missing"


async def ensure_device(target: str) -> str:
    """Connect and report the resulting state.

    `adb connect` says "connected to <target>" even when the device is sitting
    there unauthorized, so its output can't be trusted — check `adb devices`.

    On unauthorized/offline, try the one recovery that can work unattended:
    restart the local adb server and reconnect. That re-offers our key, which
    re-raises the confirmation dialog on a TV that merely dropped the session
    (a reboot, a long idle). A TV that genuinely revoked the key still comes
    back unauthorized — that needs a human, hence UNAUTHORIZED_HELP.
    """
    await adb("connect", target, timeout=15)
    state = await device_state(target)
    if state in ("unauthorized", "offline"):
        await adb("kill-server", timeout=15)
        await adb("start-server", timeout=20)
        await adb("connect", target, timeout=30)
        state = await device_state(target)
    return state


class ConnectReq(BaseModel):
    ip: str
    port: int = 5555


class PlayReq(BaseModel):
    ip: str
    port: int = 5555
    video_id: str
    use_smarttube: bool = True


@app.get("/devices")
async def devices():
    code, out, err = await adb("devices")
    return {"ok": code == 0, "stdout": out, "stderr": err}


@app.post("/connect")
async def connect(req: ConnectReq):
    target = f"{req.ip}:{req.port}"
    state = await ensure_device(target)
    return {
        "ok": state == "device",
        "target": target,
        "state": state,
        # Used to report ok=True whenever adb printed "connected", which it does
        # for an unauthorized device too — so connect looked fine and play then
        # failed. The state from `adb devices` is the honest answer.
        "stdout": state if state == "device" else "",
        "stderr": UNAUTHORIZED_HELP if state == "unauthorized" else (
            "" if state == "device" else f"device {state}"
        ),
    }


@app.post("/disconnect")
async def disconnect(req: ConnectReq):
    target = f"{req.ip}:{req.port}"
    code, out, err = await adb("disconnect", target)
    return {"ok": code == 0, "stdout": out, "stderr": err}


@app.post("/play")
async def play(req: PlayReq):
    target = f"{req.ip}:{req.port}"
    # Idempotent — re-connect each call to handle TV restarts.
    state = await ensure_device(target)
    if state == "unauthorized":
        raise HTTPException(409, UNAUTHORIZED_HELP)
    if state != "device":
        raise HTTPException(502, f"TV not reachable over adb ({state}) at {target}.")
    url = f"https://www.youtube.com/watch?v={req.video_id}"
    args = ["-s", target, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url]
    if req.use_smarttube:
        args += ["-p", "com.liskovsoft.smarttubetv.beta"]
    code, out, err = await adb(*args, timeout=20)
    if code != 0:
        # Can still race: the TV can drop the key between the check and the send.
        if "unauthorized" in (err + out).lower():
            raise HTTPException(409, UNAUTHORIZED_HELP)
        raise HTTPException(502, f"adb play failed: {err or out}")
    return {"ok": True, "stdout": out, "stderr": err}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
