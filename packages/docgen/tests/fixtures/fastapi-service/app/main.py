from fastapi import FastAPI

from .routers import items, users

app = FastAPI()

app.include_router(items.router, prefix="/api/v1")
app.include_router(users.router)


@app.get("/health")
async def health():
    return {"ok": True}


# @app.get("/disabled")
# async def disabled():
#     return {}
