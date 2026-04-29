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
        proc.kill()
        return 124, "", "timeout"
    return proc.returncode, out.decode(errors="replace").strip(), err.decode(errors="replace").strip()


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
    code, out, err = await adb("connect", target, timeout=30)
    msg = (out + " " + err).lower()
    connected = "connected" in msg or "already" in msg
    return {"ok": connected, "target": target, "stdout": out, "stderr": err}


@app.post("/disconnect")
async def disconnect(req: ConnectReq):
    target = f"{req.ip}:{req.port}"
    code, out, err = await adb("disconnect", target)
    return {"ok": code == 0, "stdout": out, "stderr": err}


@app.post("/play")
async def play(req: PlayReq):
    target = f"{req.ip}:{req.port}"
    # Ensure connected (idempotent — re-connect each call to handle TV restarts)
    await adb("connect", target, timeout=15)
    url = f"https://www.youtube.com/watch?v={req.video_id}"
    args = ["-s", target, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url]
    if req.use_smarttube:
        args += ["-p", "com.liskovsoft.smarttubetv.beta"]
    code, out, err = await adb(*args, timeout=20)
    if code != 0:
        raise HTTPException(502, f"adb play failed: {err or out}")
    return {"ok": True, "stdout": out, "stderr": err}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
