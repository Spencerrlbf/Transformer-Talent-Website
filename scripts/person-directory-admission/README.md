# Reproducible directory admission decisions

`directory-admission.ts` separates the existing source-date decision from database
reads. A versioned evidence object retains the candidate and receipt, snapshot,
all selected historical monolithic directory source metadata, header provenance,
and the candidate-wide latest earlier receipt with non-null documents. Presence,
absence, ordering, complete reviews and extra review fields are significant.

The evaluator uses the unchanged `person-v3` translators and preserves existing
chronology rules. Exact reconstruction compares both complete output arrays:
admitted documents and source reviews. An internally valid document hash alone
cannot justify invented facts, dates, omissions or cleared reviews. Capturing and
evaluating evidence copies its data, so later caller mutations do not alter a
retained decision.

This pure comparison proves output **relative to supplied evidence**. It does not
prove that every source row was supplied, that the correct prior receipt was
selected, or that input came from the directory. The forthcoming private execution
seal must capture/validate these selections under locks and bind the complete
input and output. It must be inaccessible to generic service-role RPC callers;
no public arbitrary-document sealing endpoint is introduced here.

The support-off writer keeps its existing cached-receipt behavior and uses the
pure evaluator for fresh decisions. Support-on directory execution remains
unavailable. No application/guard migration is installed or activated. The
uninstalled input-shape migration also preserves the existing string-or-object
phone representation; other source lists retain object-only entries.

```sh
PSQL=/path/to/psql bash scripts/person-directory-admission/run-local-tests.sh PORT
```

The wrapper resets only the root-owned loopback `person_directory_input_test`
fixture through its existing runner, runs the full input/application/legacy
regressions and then exercises decision reconstruction. All data is synthetic.
