from fastapi import FastAPI, APIRouter
from sqlalchemy import create_engine, Column, Integer, String, select
from sqlalchemy.orm import declarative_base, Session

engine = create_engine("sqlite:///./shop.db")
Base = declarative_base()


class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)


class Customer(Base):
    __tablename__ = "customers"
    id = Column(Integer, primary_key=True)
    name = Column(String)


app = FastAPI()
orders = APIRouter(prefix="/orders")


@orders.get("/")
def list_orders():
    with Session(engine) as s:
        return s.execute(select(Order)).scalars().all()


@app.get("/customers")
def list_customers():
    with Session(engine) as s:
        return s.execute(select(Customer)).scalars().all()


app.include_router(orders)
