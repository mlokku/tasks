from django.urls import path, re_path

from . import views

urlpatterns = [
    path("api/def", views.api_def),
    path("api/health", views.health),
    path("api/state", views.state),
    # Auth (WebAuthn passkeys + JWT session)
    path("api/auth/status", views.auth_status),
    path("api/auth/register/options", views.register_options),
    path("api/auth/register/verify", views.register_verify),
    path("api/auth/authenticate/options", views.authenticate_options),
    path("api/auth/authenticate/verify", views.authenticate_verify),
    path("api/auth/logout", views.logout),
    path("api/auth/passkeys", views.passkeys),
    path("api/auth/passkeys/<str:passkey_id>", views.passkey_detail),
    # API-key protected
    path("api/message", views.message),
    path("api/task", views.task),
    path("api/projects", views.projects_list),
    path("api/projects/<str:project_id>", views.project_detail),
    # Compiled SPA + history fallback (must be last)
    re_path(r"^(?P<path>.*)$", views.spa),
]
