{{/* Generate basic labels */}}
{{- define "nextjs-app.labels" -}}
helm.sh/chart: {{ include "nextjs-app.chart" . }}
{{ include "nextjs-app.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels */}}
{{- define "nextjs-app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nextjs-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Chart name and version */}}
{{- define "nextjs-app.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Expand the name of the chart.
*/}}
{{- define "nextjs-app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
*/}}
{{- define "nextjs-app.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Extra environment variables
*/}}
{{- define "nextjs-app.extraEnvs" -}}
{{- with .Values.extraEnvs }}
{{- toYaml . }}
{{- end }}
{{- end }}

{{/*
Secret environment variables from external-secrets
*/}}
{{- define "nextjs-app.secretEnvFrom" -}}
{{- range $key, $value := .Values.externalSecrets }}
{{- if $value.envFrom }}
- secretRef:
    name: {{ $key }}-external-secret
{{- end }}
{{- end }}
{{- end }}
