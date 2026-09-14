CREATE INDEX "customers_extra_search_trgm_idx" ON "crm"."customers" USING gin ((
    coalesce("alternate_phone", '') || ' ' ||
    coalesce("whatsapp_number", '') || ' ' ||
    coalesce("address", '')
  ) gin_trgm_ops) WHERE "crm"."customers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "equipment_search_trgm_idx" ON "crm"."equipment" USING gin ((
    coalesce("serial_number", '') || ' ' || coalesce("vc_number", '') || ' ' ||
    coalesce("mac_address", '') || ' ' || coalesce("barcode", '') || ' ' ||
    coalesce("brand", '') || ' ' || coalesce("model", '') || ' ' || "equipment_type"
  ) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "subscriptions_search_trgm_idx" ON "crm"."subscriptions" USING gin ((
    "service_account_number" || ' ' || coalesce("installation_address", '')
  ) gin_trgm_ops) WHERE "crm"."subscriptions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "locations_code_trgm_idx" ON "geo"."locations" USING gin ("code" gin_trgm_ops);