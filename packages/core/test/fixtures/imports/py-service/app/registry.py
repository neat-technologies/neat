from app import config
from app import db


def boot():
    db.connect()
    return config.DATABASE_URL
