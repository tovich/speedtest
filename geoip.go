package main

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/oschwald/maxminddb-golang"
)

// Базы DB-IP Lite (CC BY 4.0) обновляются раз в месяц и скачиваются без ключа.
const dbipURL = "https://download.db-ip.com/free/dbip-%s-lite-%s.mmdb.gz"

type GeoInfo struct {
	CountryCode   string  `json:"countryCode,omitempty"`
	Country       string  `json:"country,omitempty"`
	ContinentCode string  `json:"continentCode,omitempty"`
	Region        string  `json:"region,omitempty"`
	City          string  `json:"city,omitempty"`
	Lat           float64 `json:"lat,omitempty"`
	Lon           float64 `json:"lon,omitempty"`
	ASN           uint    `json:"asn,omitempty"`
	Org           string  `json:"org,omitempty"`
}

type names map[string]string

func (n names) pick() string {
	if v := n["ru"]; v != "" {
		return v
	}
	return n["en"]
}

type geoRecord struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
		Names   names  `maxminddb:"names"`
	} `maxminddb:"country"`
	Continent struct {
		Code string `maxminddb:"code"`
	} `maxminddb:"continent"`
	City struct {
		Names names `maxminddb:"names"`
	} `maxminddb:"city"`
	Subdivisions []struct {
		Names names `maxminddb:"names"`
	} `maxminddb:"subdivisions"`
	Location struct {
		Lat float64 `maxminddb:"latitude"`
		Lon float64 `maxminddb:"longitude"`
	} `maxminddb:"location"`
}

type asnRecord struct {
	Number uint   `maxminddb:"autonomous_system_number"`
	Org    string `maxminddb:"autonomous_system_organization"`
}

type GeoDB struct {
	dir     string
	geoKind string
	geo     atomic.Pointer[maxminddb.Reader]
	asn     atomic.Pointer[maxminddb.Reader]
}

func NewGeoDB(dir string, city bool) *GeoDB {
	kind := "country"
	if city {
		kind = "city"
	}
	return &GeoDB{dir: dir, geoKind: kind}
}

func (g *GeoDB) Ready() bool { return g.geo.Load() != nil }

func (g *GeoDB) Lookup(ip netip.Addr) *GeoInfo {
	info := &GeoInfo{}
	if db := g.geo.Load(); db != nil {
		var rec geoRecord
		if err := db.Lookup(net.IP(ip.AsSlice()), &rec); err == nil {
			info.CountryCode = rec.Country.ISOCode
			info.Country = rec.Country.Names.pick()
			info.ContinentCode = rec.Continent.Code
			info.City = rec.City.Names.pick()
			if len(rec.Subdivisions) > 0 {
				info.Region = rec.Subdivisions[0].Names.pick()
			}
			info.Lat, info.Lon = rec.Location.Lat, rec.Location.Lon
		}
	}
	if db := g.asn.Load(); db != nil {
		var rec asnRecord
		if err := db.Lookup(net.IP(ip.AsSlice()), &rec); err == nil {
			info.ASN, info.Org = rec.Number, rec.Org
		}
	}
	return info
}

// Run загружает базы при старте и проверяет их свежесть раз в сутки.
func (g *GeoDB) Run(ctx context.Context) {
	if err := os.MkdirAll(g.dir, 0o755); err != nil {
		log.Printf("geoip: %v", err)
	}
	for {
		g.refresh(g.geoKind, &g.geo)
		g.refresh("asn", &g.asn)
		select {
		case <-ctx.Done():
			return
		case <-time.After(24 * time.Hour):
		}
	}
}

func (g *GeoDB) refresh(kind string, slot *atomic.Pointer[maxminddb.Reader]) {
	file := filepath.Join(g.dir, "dbip-"+kind+"-lite.mmdb")
	st, err := os.Stat(file)
	stale := err != nil || time.Since(st.ModTime()) > 32*24*time.Hour
	if stale {
		log.Printf("geoip: скачиваю базу %s…", kind)
		if err := download(kind, file); err != nil {
			log.Printf("geoip: %s: %v", kind, err)
		} else {
			slot.Store(nil) // форсируем переоткрытие ниже
		}
	}
	if slot.Load() != nil {
		return
	}
	db, err := maxminddb.Open(file)
	if err != nil {
		log.Printf("geoip: %s: %v", kind, err)
		return
	}
	old := slot.Swap(db)
	if old != nil {
		time.AfterFunc(time.Minute, func() { old.Close() })
	}
	log.Printf("geoip: база %s загружена (%s)", kind, time.Unix(int64(db.Metadata.BuildEpoch), 0).Format("2006-01-02"))
}

// download пробует базу за текущий месяц, затем за предыдущий (новая выходит в начале месяца).
func download(kind, dst string) error {
	now := time.Now().UTC()
	var lastErr error
	for _, t := range []time.Time{now, now.AddDate(0, -1, 0)} {
		url := fmt.Sprintf(dbipURL, kind, t.Format("2006-01"))
		if lastErr = fetchGz(url, dst); lastErr == nil {
			return nil
		}
	}
	return lastErr
}

func fetchGz(url, dst string) error {
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		return err
	}
	tmp := dst + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, zr)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		// проверяем, что файл действительно читается как mmdb
		var db *maxminddb.Reader
		if db, err = maxminddb.Open(tmp); err == nil {
			db.Close()
		}
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}
