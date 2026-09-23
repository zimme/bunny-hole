terraform {
  required_version = "= 1.16.2"

  required_providers {
    bunnynet = {
      source  = "BunnyWay/bunnynet"
      version = "= 0.18.2"
    }
  }
}

provider "bunnynet" {
  # The provider reads this from BUNNYNET_API_KEY. Never put a key in a tfvars file,
  # a provider argument, a plan artifact, or an AI-agent prompt.
}
