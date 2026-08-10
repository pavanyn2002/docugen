from django.urls import path, re_path

from . import views

urlpatterns = [
    path("posts/", views.post_list),
    path("posts/<int:pk>/", views.PostDetail.as_view()),
    re_path(r"^legacy/(?P<slug>[\w-]+)/$", views.legacy_post),
    # path("hidden/", views.hidden),
]
