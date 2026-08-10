from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/")
async def list_items():
    return []


@router.post("/")
async def create_item():
    return {}


@router.get("/{item_id}")
async def get_item(item_id: int):
    return {"id": item_id}


@router.delete("/{item_id}")
async def delete_item(item_id: int):
    return None
