import {
  execute,
  GraphQLObjectType,
  GraphQLSchema,
  parse,
  Source,
  validate
} from "graphql/index.mjs";
import { createRequire } from "module";
import fetch from "node-fetch";

import build_graphql_fields_from_abis from "../build_graphql_fields_from_abis.mjs";
import actions from "../graphql_input_types/actions.mjs";
import serialize_transaction from "../serialize_transaction.mjs";

/* Importing the ABIs into a list */
const require = createRequire(import.meta.url);
const ABI_LIST = [
  { account_name: "eosio", abi: require("./abis/eosio.json") },
  { account_name: "eosio.token", abi: require("./abis/eosio.token.json") },
  { account_name: "nutrijournal", abi: require("./abis/nutrientjrn.abi.json") },
  {
    account_name: "relockeblock",
    abi: require("./abis/variantTypeExample.abi.json")
  }
];

/* Build a GraphQL schema fields */
const { mutation_fields, query_fields, ast_list } =
  build_graphql_fields_from_abis(ABI_LIST);

// Consume the query fields like any
const queries = new GraphQLObjectType({
  name: "Query",
  description: "Query table data from EOSIO blockchain.",
  fields: query_fields
});

const action_fields = actions(mutation_fields);
const mutations = new GraphQLObjectType({
  name: "Mutation",
  description: "Push transactions to the blockchain.",
  fields: {
    serialize_transaction: serialize_transaction(action_fields, ast_list)
  }
});

const query = /* GraphQL */ `
{
  {
    blockchain {
      get_info {
        server_version
        chain_id
      }
    }
  }
}
`;

const schema = new GraphQLSchema({ query: queries, mutation: mutations });

const document = parse(new Source(query));
const queryErrors = validate(schema, document);
if (queryErrors.length) throw queryErrors;

const network = { fetch, rpc_url: "https://eos.relocke.io" };

const response = execute({
  schema,
  document,
  contextValue: {
    network
  },
  fieldResolver(rootValue, args, ctx, { fieldName }) {
    return rootValue[fieldName];
  }
});

console.log(response);
