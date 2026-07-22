from sqlalchemy import Table, Column, Integer, MetaData
from sqlalchemy.orm import declarative_base
from flask_sqlalchemy import SQLAlchemy

Base = declarative_base()
db = SQLAlchemy()
metadata = MetaData()


class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)


class Widget(Base):
    __tablename__ = "widgets"
    id = Column(Integer, primary_key=True)


# Flask-SQLAlchemy: no __tablename__, table derived from the class name.
class UserProfile(db.Model):
    id = Column(Integer, primary_key=True)


audit_log = Table("audit_log", metadata, Column("id", Integer))
