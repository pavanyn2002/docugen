from fastapi import APIRouter

router = APIRouter(prefix="/users")


@router.get("/me")
async def me():
    return {}
