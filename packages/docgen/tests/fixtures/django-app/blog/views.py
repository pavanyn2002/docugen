from django.views import View
from rest_framework.decorators import api_view
from rest_framework.response import Response


@api_view(["GET", "POST"])
def post_list(request):
    return Response([])


class PostDetail(View):
    def get(self, request, pk):
        return Response({})

    def delete(self, request, pk):
        return Response(status=204)


def legacy_post(request, slug):
    return Response({})
