from sqlalchemy.orm import Session
from models import Order


def list_orders(session: Session):
    return session.query(Order).all()
