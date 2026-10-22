.PHONY: up obs down reset logs ps test load load-peak chaos calm

up:      ## core: api, worker, erp-mock, postgres, redis, queue
	docker compose up -d --build
obs:     ## core + observability
	OTEL_TRACES_EXPORTER=otlp docker compose --profile obs up -d --build
down:
	docker compose --profile obs --profile load down
reset:   ## stop everything and drop the postgres volume (re-runs the seed)
	docker compose --profile obs --profile load down -v
logs:
	docker compose logs -f api worker erp-mock
ps:
	docker compose ps
test:
	docker compose exec api npm test
load:    ## race for the same SKU (overselling + double click)
	docker compose --profile load run --rm k6
load-peak:    ## checkout spike + abusive client against the peak protection (PEAK_RATE=req/s)
	docker compose --profile load run --rm -e PEAK_RATE=$${PEAK_RATE:-1500} k6 run /scripts/peak.js
chaos:   ## degraded ERP: 30% errors, 20% timeouts
	curl -s -XPOST localhost:4000/admin/config -H 'content-type: application/json' -d '{"errorRate":0.3,"timeoutRate":0.2}'
calm:    ## healthy ERP
	curl -s -XPOST localhost:4000/admin/config -H 'content-type: application/json' -d '{"errorRate":0,"timeoutRate":0}'
