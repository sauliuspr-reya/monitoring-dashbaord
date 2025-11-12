.PHONY: build push build-push docker-build docker-push help

# Docker image configuration
IMAGE_REPO := gcr.io/mainnet-473609/monitoring-dashbaord
VERSION ?= latest

help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

docker-build: ## Build Docker image
	@echo "Building Docker image: $(IMAGE_REPO):$(VERSION)"
	docker build -t $(IMAGE_REPO):$(VERSION) .

docker-push: ## Push Docker image to GCR
	@echo "Pushing Docker image: $(IMAGE_REPO):$(VERSION)"
	gcloud auth configure-docker gcr.io --quiet
	docker push $(IMAGE_REPO):$(VERSION)
	@if [ "$(VERSION)" != "latest" ]; then \
		docker tag $(IMAGE_REPO):$(VERSION) $(IMAGE_REPO):latest && \
		docker push $(IMAGE_REPO):latest; \
	fi

build-push: docker-build docker-push ## Build and push Docker image

build: ## Build Docker image (alias for docker-build)
	@$(MAKE) docker-build

push: ## Push Docker image (alias for docker-push)
	@$(MAKE) docker-push

