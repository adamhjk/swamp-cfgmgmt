# Swamp Cfg Mgmt

This repository holds the design and implementation of a swamp extension for doing operating system configuration management. 

## Design

Swamp Cfg Mgmt allows you to do declarative, idempotent, and convergent configuration of operating systems using swamp models and workflows. 

It has the concept of a 'Cfg Mgmt Resource', which represents things like templated files, packages (from perhaps multiple package managers), and services (managed by things like systemd). These are always declarative, idempotent, convergent, and support dry-run. Resources use SSH to operate, and should use a shared library we develop to do this.

It also has the concept of a 'Cfg Mgmt Node', which is an instance of an operating system and architecture platform to execute on. Nodes are kept in a central 'Cfg Mgmt Inventory', which stores the information about how to connect to them (through storing resources and keys in vaults), and information that could be useful for conditional workflows or later work, such as operating system version, system configuration, etc.

Ideally when a workflow is run to manage Resources on target Nodes, we will have a single ssh 
connection that all resources will inherit, to save on overhead.

The remote system should require no dependencies other than a bash compatible shell.

## Workflows

### Add Node to Inventory

Specify a node to add to the inventory. Collect all the data about the node.

### Run Cfg Mgmt Resources on a set of Nodes

Given a set of nodes, run the collection of resources specified in the workflow stepsm
