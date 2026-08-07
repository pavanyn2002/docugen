from sqlalchemy import Column, Integer, String, ForeignKey
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class Shipment(Base):
    __tablename__ = "shipments"

    id = Column(Integer, primary_key=True)
    tracking_no = Column(String(64), nullable=False, unique=True)
    vendor_id = Column(Integer, ForeignKey("vendors.id"))
    legs = relationship("Leg")
