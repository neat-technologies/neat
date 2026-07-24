from fastapi import FastAPI, APIRouter

API_PREFIX = "/api/v1"

app = FastAPI()
items = APIRouter(prefix="/items")


@items.get("/{item_id}")
def read_item(item_id: int):
    return item_id


app.include_router(items, prefix=API_PREFIX)
