#include <libwebsockets.h>
#include <string.h>
#include <zlib.h>

#include "html.h"
#include "server.h"
#include "utils.h"
#include "fileapi.h"

enum { AUTH_OK, AUTH_FAIL, AUTH_ERROR };

static char *html_cache = NULL;
static size_t html_cache_len = 0;

static int send_unauthorized(struct lws *wsi, unsigned int code,
                              enum lws_token_indexes header) {
  unsigned char buffer[1024 + LWS_PRE], *p, *end;
  p = buffer + LWS_PRE;
  end = p + sizeof(buffer) - LWS_PRE;
  if (lws_add_http_header_status(wsi, code, &p, end) ||
      lws_add_http_header_by_token(wsi, header,
                                   (unsigned char *)"Basic realm=\"ttyd\"",
                                   18, &p, end) ||
      lws_add_http_header_content_length(wsi, 0, &p, end) ||
      lws_finalize_http_header(wsi, &p, end) ||
      lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE),
                LWS_WRITE_HTTP_HEADERS) < 0)
    return AUTH_FAIL;
  return lws_http_transaction_completed(wsi) ? AUTH_FAIL : AUTH_ERROR;
}

static int check_auth(struct lws *wsi, struct pss_http *pss) {
  if (server->auth_header != NULL) {
    if (lws_hdr_custom_length(wsi, server->auth_header,
                              strlen(server->auth_header)) > 0)
      return AUTH_OK;
    return send_unauthorized(wsi, HTTP_STATUS_PROXY_AUTH_REQUIRED,
                             WSI_TOKEN_HTTP_PROXY_AUTHENTICATE);
  }
  if (server->credential != NULL) {
    char buf[256];
    int len = lws_hdr_copy(wsi, buf, sizeof(buf),
                           WSI_TOKEN_HTTP_AUTHORIZATION);
    if (len >= 7 && strstr(buf, "Basic ")) {
      if (!strcmp(buf + 6, server->credential)) return AUTH_OK;
    }
    return send_unauthorized(wsi, HTTP_STATUS_UNAUTHORIZED,
                             WSI_TOKEN_HTTP_WWW_AUTHENTICATE);
  }
  return AUTH_OK;
}

static bool accept_gzip(struct lws *wsi) {
  char buf[256];
  int len = lws_hdr_copy(wsi, buf, sizeof(buf),
                         WSI_TOKEN_HTTP_ACCEPT_ENCODING);
  return len > 0 && strstr(buf, "gzip") != NULL;
}

static bool uncompress_html(char **output, size_t *output_len) {
  if (html_cache == NULL || html_cache_len == 0) {
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    if (inflateInit2(&stream, 16 + 15) != Z_OK) return false;
    html_cache_len = index_html_size;
    html_cache = xmalloc(html_cache_len);
    stream.avail_in = index_html_len;
    stream.avail_out = html_cache_len;
    stream.next_in  = (void *)index_html;
    stream.next_out = (void *)html_cache;
    int ret = inflate(&stream, Z_SYNC_FLUSH);
    inflateEnd(&stream);
    if (ret != Z_STREAM_END) {
      free(html_cache);
      html_cache = NULL;
      html_cache_len = 0;
      return false;
    }
  }
  *output = html_cache;
  *output_len = html_cache_len;
  return true;
}

static void pss_buffer_free(struct pss_http *pss) {
  if (pss->buffer != (char *)index_html && pss->buffer != html_cache)
    free(pss->buffer);
}

static void access_log(struct lws *wsi, const char *path) {
  char rip[50];
  lws_get_peer_simple(lws_get_network_wsi(wsi), rip, sizeof(rip));
  lwsl_notice("HTTP %s - %s\n", path, rip);
}

/* ── file API route matching ─────────────────────────────── */

static bool path_is(const char *path, const char *prefix) {
  size_t plen = strlen(prefix);
  if (strncmp(path, prefix, plen) != 0) return false;
  /* lws passes path without query string, so exact match or trailing / */
  return path[plen] == '\0' || path[plen] == '/';
}

/* read query string via lws header (lws strips it from the path) */
static void get_query(struct lws *wsi, char *out, size_t outsz) {
  out[0] = '\0';
  lws_hdr_copy(wsi, out, (int)outsz, WSI_TOKEN_HTTP_URI_ARGS);
}

/* ── pss_http extension ──────────────────────────────────── */
/* We store upload state inside pss->upload_buf (pointer).
   pss->upload_buf is reused as upload_state_t*.               */

int callback_http(struct lws *wsi, enum lws_callback_reasons reason,
                  void *user, void *in, size_t len) {
  struct pss_http *pss = (struct pss_http *)user;
  unsigned char buffer[4096 + LWS_PRE], *p, *end;
  char buf[256];
  bool done = false;

  switch (reason) {
    case LWS_CALLBACK_HTTP: {
      access_log(wsi, (const char *)in);
      snprintf(pss->path, sizeof(pss->path), "%s", (const char *)in);

      switch (check_auth(wsi, pss)) {
        case AUTH_OK:   break;
        case AUTH_FAIL: return 0;
        case AUTH_ERROR:
        default:        return 1;
      }

      p   = buffer + LWS_PRE;
      end = p + sizeof(buffer) - LWS_PRE;

      /* ── /token ── */
      if (strcmp(pss->path, endpoints.token) == 0) {
        const char *credential =
            server->credential != NULL ? server->credential : "";
        size_t n = snprintf(buf, sizeof(buf),
                            "{\"token\": \"%s\"}", credential);
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(
                wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                (unsigned char *)"application/json;charset=utf-8",
                30, &p, end) ||
            lws_add_http_header_content_length(
                wsi, (unsigned long)n, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE,
                      p - (buffer + LWS_PRE),
                      LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;
        pss->buffer = pss->ptr = strdup(buf);
        pss->len = n;
        lws_callback_on_writable(wsi);
        break;
      }

      /* ── redirect parent ── */
      if (strcmp(pss->path, endpoints.parent) == 0) {
        if (lws_add_http_header_status(wsi, HTTP_STATUS_FOUND, &p, end) ||
            lws_add_http_header_by_token(
                wsi, WSI_TOKEN_HTTP_LOCATION,
                (unsigned char *)endpoints.index,
                (int)strlen(endpoints.index), &p, end) ||
            lws_add_http_header_content_length(wsi, 0, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE,
                      p - (buffer + LWS_PRE),
                      LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;
        goto try_to_reuse;
      }

      /* ── file API: only when --file-root is set ── */
      if (server->file_root != NULL) {
        char query[FILE_API_PATH_MAX] = "";
        get_query(wsi, query, sizeof(query));
        char rel[FILE_API_PATH_MAX] = "";

        /* GET /files?path=... */
        if (path_is(pss->path, "/files")) {
          file_api_get_query_param(query, "path", rel, sizeof(rel));
          return file_api_list(wsi, server->file_root, rel);
        }

        /* GET /file/download?path=... */
        if (path_is(pss->path, "/file/download")) {
          file_api_get_query_param(query, "path", rel, sizeof(rel));
          return file_api_download(wsi, server->file_root, rel);
        }

        /* POST /file/upload?path=...  — begin: store upload state */
        if (path_is(pss->path, "/file/upload")) {
          char ct[256] = "";
          lws_hdr_copy(wsi, ct, sizeof(ct), WSI_TOKEN_HTTP_CONTENT_TYPE);
          file_api_get_query_param(query, "path", rel, sizeof(rel));

          upload_state_t *up = xmalloc(sizeof(upload_state_t));
          pss->buffer = (char *)up;  /* borrow buffer pointer */
          pss->ptr    = NULL;
          pss->len    = 0;

          int rc = file_api_upload_begin(wsi, server->file_root,
                                         rel, ct, up);
          if (rc != 0) {
            free(up);
            pss->buffer = NULL;
            return rc;
          }
          /* body comes in LWS_CALLBACK_HTTP_BODY */
          lws_callback_on_writable(wsi);
          break;
        }

        /* POST /file/delete  or  POST /file/rename — body buffered */
        if (path_is(pss->path, "/file/delete") ||
            path_is(pss->path, "/file/rename") ||
            path_is(pss->path, "/file/mkdir")) {
          /* body arrives in LWS_CALLBACK_HTTP_BODY; allocate a buffer */
          pss->buffer = xmalloc(4096);
          pss->ptr    = pss->buffer;
          pss->len    = 0;
          break;
        }
      }

      /* ── index.html ── */
      if (strcmp(pss->path, endpoints.index) != 0) {
        lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
        goto try_to_reuse;
      }

      const char *content_type = "text/html";
      if (server->index != NULL) {
        int n = lws_serve_http_file(wsi, server->index,
                                    content_type, NULL, 0);
        if (n < 0 || (n > 0 && lws_http_transaction_completed(wsi)))
          return 1;
      } else {
        char *output = (char *)index_html;
        size_t output_len = index_html_len;
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(
                wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                (const unsigned char *)content_type, 9, &p, end))
          return 1;
#ifdef LWS_WITH_HTTP_STREAM_COMPRESSION
        if (!uncompress_html(&output, &output_len)) return 1;
#else
        if (accept_gzip(wsi)) {
          if (lws_add_http_header_by_token(
                  wsi, WSI_TOKEN_HTTP_CONTENT_ENCODING,
                  (unsigned char *)"gzip", 4, &p, end))
            return 1;
        } else {
          if (!uncompress_html(&output, &output_len)) return 1;
        }
#endif
        if (lws_add_http_header_content_length(
                wsi, (unsigned long)output_len, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE,
                      p - (buffer + LWS_PRE),
                      LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;
        pss->buffer = pss->ptr = output;
        pss->len = output_len;
        lws_callback_on_writable(wsi);
      }
      break;
    }

    /* ── POST body chunks ── */
    case LWS_CALLBACK_HTTP_BODY: {
      if (!pss->buffer) break;

      /* upload path: pss->buffer is upload_state_t* */
      if (path_is(pss->path, "/file/upload") &&
          server->file_root != NULL) {
        upload_state_t *up = (upload_state_t *)pss->buffer;
        if (file_api_upload_body(up, (const char *)in, len) != 0) {
          /* size exceeded */
          free(up);
          pss->buffer = NULL;
          unsigned char hdr2[LWS_PRE + 256], *p2 = hdr2 + LWS_PRE,
                        *e2 = hdr2 + sizeof(hdr2) - 1;
          const char *emsg = "{\"error\":\"file too large (max 30MB)\"}";
          if (!lws_add_http_header_status(wsi, 413, &p2, e2) &&
              !lws_add_http_header_content_length(wsi, strlen(emsg), &p2, e2) &&
              !lws_finalize_http_header(wsi, &p2, e2)) {
            lws_write(wsi, hdr2 + LWS_PRE,
                      (size_t)(p2 - (hdr2 + LWS_PRE)),
                      LWS_WRITE_HTTP_HEADERS);
          }
          lws_http_transaction_completed(wsi);
          return 1;
        }
        break;
      }

      /* delete / rename: accumulate body */
      size_t have = (size_t)(pss->ptr - pss->buffer);
      if (have + len < 4095) {
        memcpy(pss->ptr, in, len);
        pss->ptr += len;
        pss->len += len;
      }
      break;
    }

    /* ── POST body complete ── */
    case LWS_CALLBACK_HTTP_BODY_COMPLETION: {
      if (!pss->buffer || server->file_root == NULL) break;


      /* upload */
      if (path_is(pss->path, "/file/upload")) {
        upload_state_t *up = (upload_state_t *)pss->buffer;
        int rc = file_api_upload_end(wsi, up);
        free(up);
        pss->buffer = NULL;
        return rc;  /* send_json sets Connection:close, lws will close cleanly */
      }

      /* null-terminate accumulated body */
      *pss->ptr = '\0';

      if (path_is(pss->path, "/file/delete")) {
        int rc = file_api_delete(wsi, server->file_root,
                                  pss->buffer, pss->len);
        free(pss->buffer);
        pss->buffer = NULL;
        return rc;
      }

      if (path_is(pss->path, "/file/rename")) {
        int rc = file_api_rename(wsi, server->file_root,
                                  pss->buffer, pss->len);
        free(pss->buffer);
        pss->buffer = NULL;
        return rc;
      }

      if (path_is(pss->path, "/file/mkdir")) {
        int rc = file_api_mkdir(wsi, server->file_root,
                                 pss->buffer, pss->len);
        free(pss->buffer);
        pss->buffer = NULL;
        return rc;
      }
      break;
    }

    case LWS_CALLBACK_HTTP_WRITEABLE:
      if (!pss->buffer || pss->len == 0) goto try_to_reuse;
      /* skip upload state stored in buffer */
      if (pss->ptr == NULL) goto try_to_reuse;

      do {
        int n = sizeof(buffer) - LWS_PRE;
        int m = lws_get_peer_write_allowance(wsi);
        if (m == 0) {
          lws_callback_on_writable(wsi);
          return 0;
        } else if (m != -1 && m < n) {
          n = m;
        }
        if (pss->ptr + n > pss->buffer + pss->len) {
          n = (int)(pss->len - (pss->ptr - pss->buffer));
          done = true;
        }
        memcpy(buffer + LWS_PRE, pss->ptr, n);
        pss->ptr += n;
        if (lws_write_http(wsi, buffer + LWS_PRE, (size_t)n) < n) {
          pss_buffer_free(pss);
          return -1;
        }
      } while (!lws_send_pipe_choked(wsi) && !done);

      if (!done && pss->ptr < pss->buffer + pss->len) {
        lws_callback_on_writable(wsi);
        break;
      }

      pss_buffer_free(pss);
      goto try_to_reuse;

    case LWS_CALLBACK_HTTP_FILE_COMPLETION:
      goto try_to_reuse;

#if (defined(LWS_OPENSSL_SUPPORT) || defined(LWS_WITH_TLS)) && \
    !defined(LWS_WITH_MBEDTLS)
    case LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION:
      if (!len || (SSL_get_verify_result((SSL *)in) != X509_V_OK)) {
        int err   = X509_STORE_CTX_get_error((X509_STORE_CTX *)user);
        int depth = X509_STORE_CTX_get_error_depth((X509_STORE_CTX *)user);
        const char *msg = X509_verify_cert_error_string(err);
        lwsl_err("client certificate verification error: %s (%d), depth: %d\n",
                 msg, err, depth);
        return 1;
      }
      break;
#endif
    default:
      break;
  }

  return 0;

try_to_reuse:
  if (lws_http_transaction_completed(wsi)) return -1;
  return 0;
}
