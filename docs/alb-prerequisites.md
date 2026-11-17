# ALB Prerequisites: Certificate and Access Logs Setup

Before deploying the ALB stack, you need to supply values for two parameters in `parameters/<env>/02-alb.json`:

- `CertificateArn` — an ACM certificate for HTTPS
- `AccessLogsBucketName` — an S3 bucket for ALB access logs (optional but recommended for non-dev environments)

---

## 1. CertificateArn

### What it is

The ARN of an AWS Certificate Manager (ACM) certificate attached to the ALB's HTTPS listener. The certificate must be in the **same region** as the ALB.

### Option A: Request a new public certificate (recommended)

1. Open the [ACM console](https://console.aws.amazon.com/acm/) in your target region.
2. Click **Request a certificate** → choose **Request a public certificate**.
3. Enter your domain name, e.g. `api.example.com` or `*.example.com` for a wildcard.
4. Choose a validation method:
   - **DNS validation** (recommended) — add a CNAME record to your DNS zone. ACM shows the exact record to add.
   - **Email validation** — an email is sent to the domain's registered contacts.
5. Complete validation. The certificate status changes to **Issued**.
6. Copy the ARN from the certificate detail page. It looks like:
   ```
   arn:aws:acm:<region>:<account-id>:certificate/<uuid>
   ```

### Option B: Import an existing certificate

If you already have a certificate from an external CA:

1. In the ACM console, click **Import a certificate**.
2. Paste your certificate body, private key, and certificate chain.
3. Click **Import**. Copy the ARN from the resulting certificate detail page.

### Using the CLI

```bash
# Request a certificate via CLI
aws acm request-certificate \
  --domain-name api.example.com \
  --validation-method DNS \
  --region us-east-1

# List existing certificates to find the ARN
aws acm list-certificates --region us-east-1
```

### Update the parameter file

Replace the placeholder value in `parameters/<env>/02-alb.json`:

```json
{
  "CertificateArn": "arn:aws:acm:us-east-1:111122223333:certificate/your-real-uuid"
}
```

---

## 2. AccessLogsBucketName

### What it is

The name of an S3 bucket where the ALB writes access logs. Each log entry records the request time, client IP, latencies, response codes, and more. This field is optional — leaving it empty disables access logging.

Access logging is recommended for staging and production environments for debugging and auditing.

### Create the S3 bucket

The bucket must be in the **same region** as the ALB, and you must attach a bucket policy that grants the ALB service permission to write logs.

#### Step 1 — Create the bucket

```bash
aws s3api create-bucket \
  --bucket my-alb-access-logs-dev \
  --region us-east-1 \
  --create-bucket-configuration LocationConstraint=us-east-1
```

> Skip `--create-bucket-configuration` if your region is `us-east-1`.

#### Step 2 — Block public access

```bash
aws s3api put-public-access-block \
  --bucket my-alb-access-logs-dev \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

#### Step 3 — Attach the ALB logging bucket policy

Replace `<region>`, `<account-id>`, and `<bucket-name>` with your values. The ALB service account ID is region-specific; find yours in the [AWS docs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html#attach-bucket-policy).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<elb-account-id>:root"
      },
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::<bucket-name>/AWSLogs/<account-id>/*"
    }
  ]
}
```

Save this as `alb-logs-policy.json`, then apply it:

```bash
aws s3api put-bucket-policy \
  --bucket my-alb-access-logs-dev \
  --policy file://alb-logs-policy.json
```

#### Step 4 — Enable bucket versioning (optional)

```bash
aws s3api put-bucket-versioning \
  --bucket my-alb-access-logs-dev \
  --versioning-configuration Status=Enabled
```

### Update the parameter file

```json
{
  "AccessLogsBucketName": "my-alb-access-logs-dev"
}
```

---

## Final parameter file example

```json
{
  "Environment": "dev",
  "CertificateArn": "arn:aws:acm:us-east-1:111122223333:certificate/12345678-1234-1234-1234-123456789012",
  "AccessLogsBucketName": "my-alb-access-logs-dev"
}
```

---

## References

- [ACM — Request a public certificate](https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-request-public.html)
- [ACM — Import a certificate](https://docs.aws.amazon.com/acm/latest/userguide/import-certificate.html)
- [ALB — Enable access logging](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html)
- [ALB service account IDs by region](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html#attach-bucket-policy)
