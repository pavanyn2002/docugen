from django.db import models


class Vendor(models.Model):
    name = models.CharField(max_length=200, unique=True)
    gstin = models.CharField(max_length=15, null=True)
    owner = models.ForeignKey("User", on_delete=models.CASCADE)
    tags = models.ManyToManyField("Tag")

    class Meta:
        db_table = "vendors"


class NotAModel:
    something = 1
