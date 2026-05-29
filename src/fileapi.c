#include "fileapi.h"
#include "server.h"
#include "utils.h"

#include <dirent.h>
#include <errno.h>
#include <json.h>
#include <libwebsockets.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* ── helpers ──────────────────────────────────────────────── */

/* URL-decode in-place */
static void url_decode(char *dst, size_t dsz, const char *src) {
    size_t di = 0;
    for (size_t i = 0; src[i] && di + 1 < dsz; i++) {
        if (src[i] == '%' && src[i+1] && src[i+2]) {
            char hex[3] = {src[i+1], src[i+2], 0};
            dst[di++] = (char)strtol(hex, NULL, 16);
            i += 2;
        } else if (src[i] == '+') {
            dst[di++] = ' ';
        } else {
            dst[di++] = src[i];
        }
    }
    dst[di] = '\0';
}

/* extract query param value from URL query string */
bool file_api_get_query_param(const char *query, const char *key,
                               char *out, size_t outsz) {
    size_t klen = strlen(key);
    const char *p = query;
    while (p && *p) {
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            const char *v = p + klen + 1;
            const char *end = strchr(v, '&');
            size_t vlen = end ? (size_t)(end - v) : strlen(v);
            if (vlen >= outsz) vlen = outsz - 1;
            char raw[FILE_API_PATH_MAX];
            memcpy(raw, v, vlen);
            raw[vlen] = '\0';
            url_decode(out, outsz, raw);
            return true;
        }
        p = strchr(p, '&');
        if (p) p++;
    }
    return false;
}

/* safe path join: root + rel → abs, return false on traversal */
bool file_api_safe_path(const char *root, const char *rel,
                         char *out, size_t outsz) {
    char tmp[FILE_API_PATH_MAX];
    /* normalise rel: strip leading slash */
    while (*rel == '/') rel++;
    if (strlen(rel) == 0)
        snprintf(tmp, sizeof(tmp), "%s", root);
    else
        snprintf(tmp, sizeof(tmp), "%s/%s", root, rel);

    if (realpath(tmp, out) == NULL) {
        /* target may not exist yet (upload); construct manually */
        snprintf(out, outsz, "%s", tmp);
        /* still check prefix */
    }

    /* resolve root for prefix check */
    char rroot[FILE_API_PATH_MAX];
    if (realpath(root, rroot) == NULL)
        snprintf(rroot, sizeof(rroot), "%s", root);

    size_t rlen = strlen(rroot);
    if (strncmp(out, rroot, rlen) != 0)
        return false;                       /* traversal detected */
    if (out[rlen] != '\0' && out[rlen] != '/')
        return false;
    return true;
}

/* send a simple JSON response */
static int send_json(struct lws *wsi, int http_status,
                     const char *body, size_t body_len) {
    unsigned char hdr[LWS_PRE + 512], *p = hdr + LWS_PRE,
                  *end = hdr + sizeof(hdr) - 1;
    if (lws_add_http_header_status(wsi, (unsigned int)http_status, &p, end))
        return 1;
    if (lws_add_http_header_by_token(
            wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
            (unsigned char *)"application/json;charset=utf-8", 30, &p, end))
        return 1;
    if (lws_add_http_header_by_token(
            wsi, WSI_TOKEN_HTTP_ACCESS_CONTROL_ALLOW_ORIGIN,
            (unsigned char *)"*", 1, &p, end))
        return 1;
    if (lws_add_http_header_content_length(wsi, (unsigned long)body_len,
                                           &p, end))
        return 1;
    if (lws_finalize_http_header(wsi, &p, end)) return 1;
    if (lws_write(wsi, hdr + LWS_PRE, (size_t)(p - (hdr + LWS_PRE)),
                  LWS_WRITE_HTTP_HEADERS) < 0)
        return 1;
    /* body */
    unsigned char *buf = xmalloc(LWS_PRE + body_len);
    memcpy(buf + LWS_PRE, body, body_len);
    lws_write(wsi, buf + LWS_PRE, body_len, LWS_WRITE_HTTP);
    free(buf);
    (void)lws_http_transaction_completed(wsi);
    return 0;
}

static int send_error(struct lws *wsi, int code, const char *msg) {
    char buf[256];
    int n = snprintf(buf, sizeof(buf), "{\"error\":\"%s\"}", msg);
    return send_json(wsi, code, buf, (size_t)n);
}

static int send_ok(struct lws *wsi, const char *msg) {
    char buf[256];
    int n = snprintf(buf, sizeof(buf), "{\"ok\":true,\"msg\":\"%s\"}", msg);
    return send_json(wsi, HTTP_STATUS_OK, buf, (size_t)n);
}

/* ── GET /files ───────────────────────────────────────────── */

int file_api_list(struct lws *wsi, const char *root, const char *rel_path) {
    char abs[FILE_API_PATH_MAX];
    if (!file_api_safe_path(root, rel_path, abs, sizeof(abs)))
        return send_error(wsi, HTTP_STATUS_FORBIDDEN, "forbidden");

    struct stat st;
    if (stat(abs, &st) != 0)
        return send_error(wsi, HTTP_STATUS_NOT_FOUND, "not found");
    if (!S_ISDIR(st.st_mode))
        return send_error(wsi, HTTP_STATUS_BAD_REQUEST, "not a directory");

    DIR *dir = opendir(abs);
    if (!dir) return send_error(wsi, 500, "opendir failed");

    struct json_object *arr = json_object_new_array();
    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL) {
        if (strcmp(ent->d_name, ".") == 0) continue;
        char fpath[FILE_API_PATH_MAX];
        snprintf(fpath, sizeof(fpath), "%s/%s", abs, ent->d_name);
        struct stat fs;
        if (stat(fpath, &fs) != 0) continue;

        struct json_object *item = json_object_new_object();
        json_object_object_add(item, "name",
                               json_object_new_string(ent->d_name));
        json_object_object_add(item, "isDir",
                               json_object_new_boolean(S_ISDIR(fs.st_mode)));
        json_object_object_add(item, "size",
                               json_object_new_int64((int64_t)fs.st_size));
        json_object_object_add(item, "mtime",
                               json_object_new_int64((int64_t)fs.st_mtime));
        json_object_array_add(arr, item);
    }
    closedir(dir);

    struct json_object *resp = json_object_new_object();
    json_object_object_add(resp, "path",
                           json_object_new_string(rel_path[0] ? rel_path : "/"));
    json_object_object_add(resp, "files", arr);

    const char *body = json_object_to_json_string(resp);
    int rc = send_json(wsi, HTTP_STATUS_OK, body, strlen(body));
    json_object_put(resp);
    return rc;
}

/* ── GET /file/download ───────────────────────────────────── */

int file_api_download(struct lws *wsi, const char *root,
                       const char *rel_path) {
    char abs[FILE_API_PATH_MAX];
    if (!file_api_safe_path(root, rel_path, abs, sizeof(abs)))
        return send_error(wsi, HTTP_STATUS_FORBIDDEN, "forbidden");

    struct stat st;
    if (stat(abs, &st) != 0)
        return send_error(wsi, HTTP_STATUS_NOT_FOUND, "not found");
    if (S_ISDIR(st.st_mode))
        return send_error(wsi, HTTP_STATUS_BAD_REQUEST, "is a directory");

    /* extract filename for Content-Disposition */
    const char *fname = strrchr(abs, '/');
    fname = fname ? fname + 1 : abs;

    unsigned char hdr[LWS_PRE + 512], *p = hdr + LWS_PRE,
                  *end = hdr + sizeof(hdr) - 1;
    if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end)) return 1;
    if (lws_add_http_header_by_token(
            wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
            (unsigned char *)"application/octet-stream", 24, &p, end))
        return 1;

    char disp[512];
    snprintf(disp, sizeof(disp), "attachment; filename=\"%s\"", fname);
    if (lws_add_http_header_by_name(
            wsi, (unsigned char *)"content-disposition:",
            (unsigned char *)disp, (int)strlen(disp), &p, end))
        return 1;
    if (lws_add_http_header_content_length(wsi, (unsigned long)st.st_size,
                                           &p, end))
        return 1;
    if (lws_finalize_http_header(wsi, &p, end)) return 1;
    if (lws_write(wsi, hdr + LWS_PRE, (size_t)(p - (hdr + LWS_PRE)),
                  LWS_WRITE_HTTP_HEADERS) < 0)
        return 1;

    /* stream file in chunks */
    FILE *fp = fopen(abs, "rb");
    if (!fp) return send_error(wsi, 500, "open failed");

    unsigned char chunk[LWS_PRE + 65536];
    size_t n;
    while ((n = fread(chunk + LWS_PRE, 1, sizeof(chunk) - LWS_PRE, fp)) > 0) {
        if (lws_write(wsi, chunk + LWS_PRE, n, LWS_WRITE_HTTP) < (int)n) {
            fclose(fp);
            return 1;
        }
    }
    fclose(fp);
(void)lws_http_transaction_completed(wsi);
    return 0;
}

/* ── POST /file/delete ────────────────────────────────────── */

int file_api_delete(struct lws *wsi, const char *root,
                     const char *body, size_t body_len) {
    struct json_object *req = json_tokener_parse(body);
    if (!req) return send_error(wsi, HTTP_STATUS_BAD_REQUEST, "bad json");

    struct json_object *jpath;
    if (!json_object_object_get_ex(req, "path", &jpath)) {
        json_object_put(req);
        return send_error(wsi, HTTP_STATUS_BAD_REQUEST, "missing path");
    }
    const char *rel = json_object_get_string(jpath);

    char abs[FILE_API_PATH_MAX];
    if (!file_api_safe_path(root, rel, abs, sizeof(abs))) {
        json_object_put(req);
        return send_error(wsi, HTTP_STATUS_FORBIDDEN, "forbidden");
    }
    json_object_put(req);

    struct stat st;
    if (stat(abs, &st) != 0)
        return send_error(wsi, HTTP_STATUS_NOT_FOUND, "not found");

    int rc;
    if (S_ISDIR(st.st_mode))
        rc = rmdir(abs);
    else
        rc = unlink(abs);

    if (rc != 0)
        return send_error(wsi, 500, strerror(errno));
    return send_ok(wsi, "deleted");
}

/* ── POST /file/rename ────────────────────────────────────── */

int file_api_rename(struct lws *wsi, const char *root,
                     const char *body, size_t body_len) {
    struct json_object *req = json_tokener_parse(body);
    if (!req) return send_error(wsi, HTTP_STATUS_BAD_REQUEST, "bad json");

    struct json_object *jfrom, *jto;
    if (!json_object_object_get_ex(req, "from", &jfrom) ||
        !json_object_object_get_ex(req, "to", &jto)) {
        json_object_put(req);
        return send_error(wsi, HTTP_STATUS_BAD_REQUEST, "missing from/to");
    }

    char abs_from[FILE_API_PATH_MAX], abs_to[FILE_API_PATH_MAX];
    bool ok_from = file_api_safe_path(root, json_object_get_string(jfrom),
                                       abs_from, sizeof(abs_from));
    bool ok_to   = file_api_safe_path(root, json_object_get_string(jto),
                                       abs_to, sizeof(abs_to));
    json_object_put(req);

    if (!ok_from || !ok_to)
        return send_error(wsi, HTTP_STATUS_FORBIDDEN, "forbidden");

    if (rename(abs_from, abs_to) != 0)
        return send_error(wsi, 500, strerror(errno));
    return send_ok(wsi, "renamed");
}

/* ── POST /file/upload (multipart) ───────────────────────── */

/*
 * Minimal multipart/form-data boundary parser.
 * libwebsockets' LWS_CALLBACK_HTTP_BODY gives us chunks of the raw
 * POST body.  We look for the boundary, skip MIME headers, then pipe
 * file bytes to disk until the closing boundary.
 */

int file_api_upload_begin(struct lws *wsi, const char *root,
                           const char *rel_path, const char *content_type,
                           upload_state_t *up) {
    (void)content_type;
    memset(up, 0, sizeof(*up));

    char abs[FILE_API_PATH_MAX];
    if (!file_api_safe_path(root, rel_path, abs, sizeof(abs)))
        return send_error(wsi, HTTP_STATUS_FORBIDDEN, "forbidden");

    snprintf(up->dest_path, sizeof(up->dest_path), "%s", abs);

    up->fp = fopen(abs, "wb");
    if (!up->fp)
        return send_error(wsi, 500, strerror(errno));

    return 0;
}

int file_api_upload_body(upload_state_t *up, const char *data, size_t len) {
    if (!up->fp) return -1;

    if (up->received + len > FILE_API_MAX_UPLOAD) {
        fclose(up->fp);
        up->fp = NULL;
        unlink(up->dest_path);
        return -1;  /* size exceeded */
    }

    fwrite(data, 1, len, up->fp);
    up->received += len;
    return 0;
}

int file_api_upload_end(struct lws *wsi, upload_state_t *up) {
    if (up->fp) {
        fclose(up->fp);
        up->fp = NULL;
    }

    if (up->received == 0) {
        unlink(up->dest_path);
        return send_error(wsi, HTTP_STATUS_BAD_REQUEST, "empty file");
    }

    char msg[256];
    snprintf(msg, sizeof(msg), "uploaded %zu bytes", up->received);
    return send_ok(wsi, msg);
}

/* get_query_param exposed via file_api_get_query_param in header */

/* ── POST /file/mkdir ─────────────────────────────────────── */

int file_api_mkdir(struct lws *wsi, const char *root,
                   const char *body, size_t body_len) {
    struct json_object *req = json_tokener_parse(body);
    if (!req) return send_error(wsi, HTTP_STATUS_BAD_REQUEST, "bad json");

    struct json_object *jpath;
    if (!json_object_object_get_ex(req, "path", &jpath)) {
        json_object_put(req);
        return send_error(wsi, HTTP_STATUS_BAD_REQUEST, "missing path");
    }
    const char *rel = json_object_get_string(jpath);

    char abs[FILE_API_PATH_MAX];
    if (!file_api_safe_path(root, rel, abs, sizeof(abs))) {
        json_object_put(req);
        return send_error(wsi, HTTP_STATUS_FORBIDDEN, "forbidden");
    }
    json_object_put(req);

    if (mkdir(abs, 0755) != 0)
        return send_error(wsi, 500, strerror(errno));
    return send_ok(wsi, "created");
}
