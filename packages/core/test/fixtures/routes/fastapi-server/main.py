from fastapi import FastAPI, APIRouter

app = FastAPI()
items = APIRouter(prefix="/items", tags=["items"])
private = APIRouter(tags=["private"], prefix="/private")


@app.get("/health")
async def health():
    return {"ok": True}


@app.api_route("/ping", methods=["GET", "POST"])
def ping():
    return "pong"


@items.get("/")
def list_items():
    return []


@items.get("/{item_id}")
def read_item(item_id: int):
    return item_id


@items.post("/")
def create_item():
    return 1


@items.patch(
    "/{item_id}",
    response_model=None,
)
async def update_item(item_id: int):
    return item_id


@private.delete("/{id}")
def remove(id: int):
    return None
