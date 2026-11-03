package cataloghttp

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/catalog/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

type fetchConfigInput struct {
	Enabled           *bool           `json:"enabled"`
	ScheduleMode      string          `json:"schedule_mode"`
	AtMinute          *int            `json:"at_minute"`
	WindowStartMinute *int            `json:"window_start_minute"`
	WindowEndMinute   *int            `json:"window_end_minute"`
	UTCOffsetMinutes  *int            `json:"utc_offset_minutes"`
	Keys              []fetchKeyInput `json:"keys"`
}

type fetchKeyInput struct {
	ClientID string `json:"client_id"`
	APIKey   string `json:"api_key"`
}

func (in fetchConfigInput) valid() bool {
	if in.Enabled == nil || in.AtMinute == nil || in.WindowStartMinute == nil || in.WindowEndMinute == nil || in.UTCOffsetMinutes == nil || in.Keys == nil {
		return false
	}
	if in.ScheduleMode != "fixed" && in.ScheduleMode != "random" || *in.AtMinute < 0 || *in.AtMinute > 1439 || *in.WindowStartMinute < 0 || *in.WindowEndMinute > 1439 || *in.WindowEndMinute <= *in.WindowStartMinute || *in.UTCOffsetMinutes < -720 || *in.UTCOffsetMinutes > 840 || len(in.Keys) > 8 || *in.Enabled && len(in.Keys) == 0 {
		return false
	}
	seen := map[string]bool{}
	for _, key := range in.Keys {
		if key.ClientID == "" || len(key.ClientID) > 256 || strings.TrimSpace(key.ClientID) != key.ClientID || seen[key.ClientID] || len(key.APIKey) > 8192 {
			return false
		}
		seen[key.ClientID] = true
	}
	return true
}

var errMissingFetchKey = errors.New("catalog key must be provided")
var errDisabledFetchKeys = errors.New("catalog has no active keys")

func (h Host) saveFetchConfig(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.account(w, r)
	if !ok {
		return
	}
	if status, message, allowed := access.SuperAdmin(actor); !allowed {
		writeErr(w, status, message, "forbidden")
		return
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	var input fetchConfigInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || !input.valid() {
		writeErr(w, http.StatusBadRequest, "类目抓取配置无效", "validation")
		return
	}
	var next *int64
	if *input.Enabled {
		due := service.NextFixed(*input.AtMinute, *input.UTCOffsetMinutes, h.Now())
		if input.ScheduleMode == "random" {
			var err error
			due, err = service.NextRandom(*input.WindowStartMinute, *input.WindowEndMinute, *input.UTCOffsetMinutes, h.Now(), false)
			if err != nil {
				writeErr(w, 500, access.MsgUnavailable, "internal")
				return
			}
		}
		value := due.UnixMilli()
		next = &value
	}

	err := db.InTx(r.Context(), h.Pool, db.AppRole(), func(tx pgx.Tx) error {
		defer writer.Forget(tx)
		if _, err := writer.Assert(r.Context(), tx, "admin", writer.ProcessIdentity(), h.Now().UnixMilli(), "类目配置写入未启用"); err != nil {
			return err
		}
		var publicID string
		if err := tx.QueryRow(r.Context(), `SELECT public_id FROM account_users WHERE id=$1`, actor.UserID).Scan(&publicID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `INSERT INTO platform_catalog_fetch_config(singleton) VALUES(true) ON CONFLICT DO NOTHING`); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `SELECT singleton FROM platform_catalog_fetch_config WHERE singleton FOR UPDATE`); err != nil {
			return err
		}
		type storedKey struct {
			keyID             string
			nonce, ciphertext []byte
			disabled          *int64
		}
		kept := map[string]storedKey{}
		rows, err := tx.Query(r.Context(), `SELECT client_id,COALESCE(api_key_key_id,''),api_key_nonce,api_key_ciphertext,disabled_at_ms FROM platform_catalog_fetch_keys`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var client string
			var key storedKey
			if err := rows.Scan(&client, &key.keyID, &key.nonce, &key.ciphertext, &key.disabled); err != nil {
				rows.Close()
				return err
			}
			kept[client] = key
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM platform_catalog_fetch_keys`); err != nil {
			return err
		}
		availableKeys := 0
		for i, item := range input.Keys {
			key, found := kept[item.ClientID]
			if strings.TrimSpace(item.APIKey) != "" {
				key = storedKey{keyID: "catalog-v1"}
				key.nonce, key.ciphertext, err = seal.SealBlob(h.Seals.Primary, key.keyID, []byte(strings.TrimSpace(item.APIKey)))
				if err != nil {
					return err
				}
			} else if !found || len(key.nonce) == 0 || len(key.ciphertext) == 0 {
				return errMissingFetchKey
			}
			if key.disabled == nil {
				availableKeys++
			}
			if _, err := tx.Exec(r.Context(), `INSERT INTO platform_catalog_fetch_keys(position,client_id,api_key_key_id,api_key_nonce,api_key_ciphertext,disabled_at_ms) VALUES($1,$2,$3,$4,$5,$6)`, i+1, item.ClientID, key.keyID, key.nonce, key.ciphertext, key.disabled); err != nil {
				return err
			}
		}
		if *input.Enabled && availableKeys == 0 {
			return errDisabledFetchKeys
		}
		if _, err := tx.Exec(r.Context(), `UPDATE platform_catalog_fetch_config SET enabled=$1,schedule_mode=$2,at_minute=$3,window_start_minute=$4,window_end_minute=$5,utc_offset_minutes=$6,next_run_at_ms=$7,lease_until_ms=NULL,lease_epoch=lease_epoch+1,updated_at_ms=$8,updated_by_account_uuid=$9,updated_at=clock_timestamp() WHERE singleton`, *input.Enabled, input.ScheduleMode, *input.AtMinute, *input.WindowStartMinute, *input.WindowEndMinute, *input.UTCOffsetMinutes, next, h.Now().UnixMilli(), publicID); err != nil {
			return err
		}
		return sqlc.New(tx).InsertAudit(r.Context(), sqlc.InsertAuditParams{OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "catalog_fetch_config", EntityID: "singleton", ApiMethod: "PUT", ApiPath: "/api/admin/catalog/fetch-config", Action: "catalog_fetch_config_updated", Message: "类目配置已保存"})
	})
	if err != nil {
		switch {
		case errors.Is(err, errMissingFetchKey):
			writeErr(w, http.StatusBadRequest, "新配置的 Client-Id 必须填写 Api-Key", "validation")
		case errors.Is(err, errDisabledFetchKeys):
			writeErr(w, http.StatusBadRequest, "启用抓取至少需要一把可用密钥", "validation")
		case writer.IsDisabled(err):
			writeErr(w, http.StatusServiceUnavailable, "类目配置写入未启用", "writes_disabled")
		default:
			writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		}
		return
	}
	h.fetchConfig(w, r)
}
