{{- define "josevdemo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "josevdemo.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "josevdemo.name" . -}}
{{- end -}}
{{- end -}}

{{- define "josevdemo.labels" -}}
app.kubernetes.io/name: {{ include "josevdemo.name" . }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "josevdemo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "josevdemo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "josevdemo.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "josevdemo.pullPolicy" -}}
{{- .Values.image.pullPolicy | default .Values.global.imagePullPolicy | default "IfNotPresent" -}}
{{- end -}}
