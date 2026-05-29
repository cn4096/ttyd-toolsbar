#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <libwebsockets.h>

#define FILE_API_MAX_UPLOAD  (30 * 1024 * 1024)   /* 30 MB */
#define FILE_API_PATH_MAX    4096

/* safe-join: resolve path under root, return false if traversal detected */
bool file_api_safe_path(const char *root, const char *rel, char *out, size_t outsz);

/* extract query param from URL query string */
bool file_api_get_query_param(const char *query, const char *key, char *out, size_t outsz);

/* GET /files?path=...   → JSON listing */
int file_api_list(struct lws *wsi, const char *root, const char *rel_path);

/* GET /file/download?path=...  → stream file */
int file_api_download(struct lws *wsi, const char *root, const char *rel_path);

/* POST /file/delete   body: {"path":"..."} */
int file_api_delete(struct lws *wsi, const char *root, const char *body, size_t body_len);

/* POST /file/rename   body: {"from":"...","to":"..."} */
int file_api_rename(struct lws *wsi, const char *root, const char *body, size_t body_len);

/* POST /file/mkdir  body: {"path":"..."} */
int file_api_mkdir(struct lws *wsi, const char *root, const char *body, size_t body_len);

/* pss for upload state (embed in pss_http) */
typedef struct {
    char        dest_path[FILE_API_PATH_MAX];
    FILE       *fp;
    size_t      received;
} upload_state_t;

int file_api_upload_begin(struct lws *wsi, const char *root,
                          const char *rel_path, const char *content_type,
                          upload_state_t *up);
int file_api_upload_body(upload_state_t *up, const char *data, size_t len);
int file_api_upload_end(struct lws *wsi, upload_state_t *up);
